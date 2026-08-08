/**
 * Tech sub-slot runner (PRD F6.2/F6.3): same shape as the booking transition
 * runner — row lock → pure domain decision → versioned update → ledger rows →
 * outbox event, in one transaction.
 *
 * Money execution: ledger intents are written here (charge on booked, release/
 * refund/fee at terminal states — same invariants as bookings). External
 * movement runs through the payment gateway only for bookings today; tech
 * payouts via Stripe land when techs get Connect onboarding (follow-up in
 * the payments task). With the Null gateway the ledger IS the execution.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  ACTIVE_SUBSLOT_STATES,
  decideSubslot,
  newId,
  soundPlan,
  type SubslotEvent,
  type SubslotState,
} from "@gigit/domain";
import { db, type Tx } from "./client.js";
import { appendEvent } from "./events.js";
import { lockActiveProfileOwners } from "./account-gate.js";
import { recordLedgerEntry } from "./ledger.js";
import {
  bookings,
  performers,
  techs,
  techSubslotApplications,
  techSubslots,
  venues,
} from "./schema.js";
import { ConcurrentUpdateError, pgErrorCode } from "./transition.js";

export class SubslotNotFoundError extends Error {}
export class SubslotAssigneeChangedError extends Error {
  readonly code = "subslot_assignee_changed";
  constructor(
    readonly subslotId: string,
    readonly expectedTechId: string,
    readonly actualTechId: string | null,
  ) {
    super(`sound job ${subslotId} is no longer assigned to ${expectedTechId}`);
  }
}
export class TechSubslotNotOpenError extends Error {
  readonly code = "tech_subslot_not_open";
}
export class TechSubslotParentUnavailableError extends Error {
  readonly code = "tech_subslot_parent_unavailable";
}
export class TechSubslotAlreadyActiveError extends Error {
  readonly code = "tech_subslot_already_active";
  constructor(readonly bookingId: string) {
    super(`booking ${bookingId} already has an active sound job`);
  }
}
export class TechUnavailableError extends Error {
  readonly code = "tech_unavailable";
  constructor(
    readonly techId: string,
    readonly conflictingSubslotId: string,
  ) {
    super(`tech ${techId} already has overlapping sound job ${conflictingSubslotId}`);
  }
}
export type TechSubslotApplicationErrorReason =
  | "duplicate"
  | "not_found"
  | "not_submitted";
export class TechSubslotApplicationError extends Error {
  readonly code = "tech_subslot_application";
  constructor(readonly reason: TechSubslotApplicationErrorReason) {
    super(`sound-job application is ${reason.replace("_", " ")}`);
  }
}

export interface SubslotTransitionOptions {
  now?: Date;
  /** @internal Deterministic seam for a request that waits across downbeat. */
  clock?: () => Date;
  /** Reuse a caller transaction for compound application + booking actions. */
  tx?: Tx;
  /** Guard TECH_CANCELLED against cancelling a replacement tech's booking. */
  expectedTechId?: string;
}

export interface TechSubslotActionOptions {
  /** @internal Deterministic seam for a request that waits across downbeat. */
  clock?: () => Date;
}

/**
 * A sound job only exists while the night it hangs off does: the parent
 * booking must still be confirmed and downbeat must still be ahead. Create,
 * the TECH_CANCELLED pre-check and the apply/book gate all need exactly this
 * predicate against a locked parent row — as three hand-written copies they
 * could drift, and a listing that outlives its own gig is the failure that
 * matters. Private on purpose: callers must hold the parent lock first.
 */
function parentIsAvailable(
  parent: { state: string; terms: { startsAt: string } } | undefined,
  now: Date,
): boolean {
  const startsAt = parent
    ? new Date(parent.terms.startsAt).getTime()
    : Number.NaN;
  return (
    parent?.state === "confirmed" &&
    Number.isFinite(startsAt) &&
    startsAt > now.getTime()
  );
}

/** Create the sub-slot from the parent booking's real context (F6.3). */
export async function createTechSubslot(input: {
  bookingId: string;
  payer: "venue" | "performer";
  budgetCents: number;
  actor: string;
  notes?: string;
}): Promise<string> {
  const id = newId("slot"); // sub-slots share the slot id space deliberately
  try {
    await db().transaction(async (tx) => {
      const [partyIds] = await tx
        .select({
          performerId: bookings.performerId,
          venueId: bookings.venueId,
        })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId));
      if (!partyIds)
        throw new SubslotNotFoundError(`booking ${input.bookingId} not found`);
      await lockActiveProfileOwners(tx, {
        performerIds: [partyIds.performerId],
        venueIds: [partyIds.venueId],
        additionalUserIds: [input.actor],
      });
      const [row] = await tx
        .select({ booking: bookings, venue: venues, performer: performers })
        .from(bookings)
        .innerJoin(venues, eq(bookings.venueId, venues.id))
        .innerJoin(performers, eq(bookings.performerId, performers.id))
        .where(eq(bookings.id, input.bookingId))
        .for("update", { of: bookings });
      if (!row)
        throw new SubslotNotFoundError(`booking ${input.bookingId} not found`);
      if (!parentIsAvailable(row.booking, new Date()))
        throw new TechSubslotParentUnavailableError();
      const [active] = await tx
        .select({ id: techSubslots.id })
        .from(techSubslots)
        .where(
          and(
            eq(techSubslots.bookingId, input.bookingId),
            inArray(techSubslots.state, ACTIVE_SUBSLOT_STATES),
          ),
        )
        .limit(1);
      if (active) throw new TechSubslotAlreadyActiveError(input.bookingId);

      const plan = soundPlan(row.venue.paInventory, row.performer.techNeeds);
      await tx.insert(techSubslots).values({
        id,
        bookingId: input.bookingId,
        payer: input.payer,
        budgetCents: input.budgetCents,
        needs: {
          verdict: plan.verdict,
          gaps: plan.gaps,
          inputs: row.performer.techNeeds.inputs,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });
      await appendEvent(tx, {
        actor: input.actor,
        kind: "subslot.created",
        subjectType: "tech_subslot",
        subjectId: id,
        payload: { bookingId: input.bookingId, payer: input.payer, budgetCents: input.budgetCents },
      });
    });
  } catch (e) {
    // The parent lock makes normal creates deterministic. Keep the SQLSTATE
    // mapping as a final backstop for direct/legacy writers racing this path.
    if (pgErrorCode(e) === "23505")
      throw new TechSubslotAlreadyActiveError(input.bookingId);
    throw e;
  }
  return id;
}

/** One transaction: lock → decide → versioned update → ledger → event. */
export async function runSubslotTransition(
  subslotId: string,
  event: SubslotEvent,
  actor: string,
  options: SubslotTransitionOptions = {},
): Promise<{ from: SubslotState; to: SubslotState }> {
  const currentTime = () => options.now ?? options.clock?.() ?? new Date();
  const apply = async (tx: Tx) => {
    // A tech cancellation reopens the listing, so parent availability is part
    // of the transition's atomic precondition. Take parent → subslot locks in
    // the same order as apply/book/create to avoid reopening after a concurrent
    // parent cancellation, post-gig close, or downbeat.
    if (event.kind === "TECH_CANCELLED") {
      const [candidate] = await tx
        .select({ bookingId: techSubslots.bookingId })
        .from(techSubslots)
        .where(eq(techSubslots.id, subslotId));
      if (!candidate)
        throw new SubslotNotFoundError(`sub-slot ${subslotId} not found`);
      const [parent] = await tx
        .select({ state: bookings.state, terms: bookings.terms })
        .from(bookings)
        .where(eq(bookings.id, candidate.bookingId))
        .for("update");
      if (!parentIsAvailable(parent, currentTime()))
        throw new TechSubslotParentUnavailableError();
    }

    const [locked] = await tx
      .select({
        subslot: techSubslots,
        terms: bookings.terms,
        venueId: bookings.venueId,
        performerId: bookings.performerId,
      })
      .from(techSubslots)
      .innerJoin(bookings, eq(techSubslots.bookingId, bookings.id))
      .where(eq(techSubslots.id, subslotId))
      .for("update", { of: techSubslots });
    if (!locked) throw new SubslotNotFoundError(`sub-slot ${subslotId} not found`);
    const s = locked.subslot;
    // The parent check above may have waited on either lock. Re-read the clock
    // only after the subslot is ours so a request that began just before
    // downbeat cannot reopen the listing after downbeat.
    const now = currentTime();
    if (event.kind === "TECH_CANCELLED") {
      const startsAt = new Date(locked.terms.startsAt).getTime();
      if (!Number.isFinite(startsAt) || startsAt <= now.getTime())
        throw new TechSubslotParentUnavailableError();
    }
    if (
      options.expectedTechId !== undefined &&
      s.techId !== options.expectedTechId
    )
      throw new SubslotAssigneeChangedError(
        subslotId,
        options.expectedTechId,
        s.techId,
      );

    const decision = decideSubslot(
      {
        state: s.state as SubslotState,
        budgetCents: s.budgetCents,
        gigStartsAt: new Date(locked.terms.startsAt),
        techId: s.techId,
      },
      event,
      now,
    );

    const updated = await tx
      .update(techSubslots)
      .set({
        state: decision.next,
        version: sql`${techSubslots.version} + 1`,
        ...(decision.techId !== undefined ? { techId: decision.techId } : {}),
      })
      .where(and(eq(techSubslots.id, subslotId), eq(techSubslots.version, s.version)))
      .returning({ id: techSubslots.id });
    if (updated.length === 0) throw new ConcurrentUpdateError(subslotId);

    // A reopened sound slot is a fresh selection round, so the old applications
    // go. This used to run in the cancel route AFTER the transition committed:
    // a crash in that two-statement window left the sub-slot `open` with stale
    // rows, and the apply route's conflict guard then told every one of those
    // techs "You've already applied" forever — while the copy had just told
    // them the slot was back open. Inside the transaction it's all-or-nothing.
    if (s.state === "booked" && decision.next === "open")
      await tx
        .delete(techSubslotApplications)
        .where(eq(techSubslotApplications.subslotId, subslotId));

    const payerParty =
      s.payer === "venue" ? `venue:${locked.venueId}` : `performer:${locked.performerId}`;
    const techParty = `tech:${decision.techId ?? s.techId ?? "unassigned"}`;
    for (const fx of decision.effects) {
      if (fx.kind === "subslot_charge")
        // version-keyed: a reopened sub-slot (tech cancelled, full refund)
        // must charge AGAIN when re-booked — a stable key would swallow it
        await recordLedgerEntry(tx, {
          bookingId: s.bookingId,
          entryType: "charge",
          debitParty: payerParty,
          creditParty: "platform",
          amountCents: fx.amountCents,
          idempotencyKey: `${subslotId}:charge:${s.version}`,
        });
      else if (fx.kind === "subslot_release")
        await recordLedgerEntry(tx, {
          bookingId: s.bookingId,
          entryType: "release",
          debitParty: "platform",
          creditParty: techParty,
          amountCents: fx.amountCents,
          idempotencyKey: `${subslotId}:release`,
        });
      else if (fx.kind === "subslot_refund")
        await recordLedgerEntry(tx, {
          bookingId: s.bookingId,
          entryType: "refund",
          debitParty: "platform",
          creditParty: payerParty,
          amountCents: fx.amountCents,
          idempotencyKey: `${subslotId}:refund:${s.version}`,
        });
      else if (fx.kind === "subslot_fee") {
        if (fx.feeCents > 0)
          await recordLedgerEntry(tx, {
            bookingId: s.bookingId,
            entryType: "fee",
            debitParty: "platform",
            creditParty: techParty,
            amountCents: fx.feeCents,
            idempotencyKey: `${subslotId}:fee:${s.version}`,
          });
        if (fx.refundCents > 0)
          await recordLedgerEntry(tx, {
            bookingId: s.bookingId,
            entryType: "refund",
            debitParty: "platform",
            creditParty: payerParty,
            amountCents: fx.refundCents,
            idempotencyKey: `${subslotId}:refund:fee:${s.version}`,
          });
      } else if (fx.kind === "subslot_reliability_strike" && s.techId) {
        await tx
          .update(techs)
          .set({
            reliabilityStrikes: sql`${techs.reliabilityStrikes} + 1`,
          })
          .where(eq(techs.id, s.techId));
      }
    }

    const resolvedApplications =
      decision.next !== "open" && decision.next !== "booked"
        ? await tx
            .update(techSubslotApplications)
            .set({ status: "declined" })
            .where(
              and(
                eq(techSubslotApplications.subslotId, subslotId),
                eq(techSubslotApplications.status, "submitted"),
              ),
            )
            .returning({
              id: techSubslotApplications.id,
              techId: techSubslotApplications.techId,
            })
        : [];

    await appendEvent(tx, {
      actor,
      kind: "subslot.transition",
      subjectType: "tech_subslot",
      subjectId: subslotId,
      payload: { event: event.kind, from: s.state, to: decision.next, effects: decision.effects },
    });
    for (const application of resolvedApplications)
      await appendEvent(tx, {
        actor,
        kind: "subslot.application_declined",
        subjectType: "tech_subslot",
        subjectId: subslotId,
        payload: {
          applicationId: application.id,
          techId: application.techId,
          reason: "sound_job_closed",
          effects: [
            {
              kind: "notify",
              template: "subslot_application_cancelled",
              to: "applicant",
            },
          ],
        },
      });
    return { from: s.state as SubslotState, to: decision.next };
  };
  return options.tx ? apply(options.tx) : db().transaction(apply);
}

async function lockTechSubslot(tx: Tx, subslotId: string) {
  const [subslot] = await tx
    .select({ id: techSubslots.id, state: techSubslots.state })
    .from(techSubslots)
    .where(eq(techSubslots.id, subslotId))
    .for("update");
  if (!subslot)
    throw new SubslotNotFoundError(`sub-slot ${subslotId} not found`);
  return subslot;
}

/**
 * Gate both booking parties and the tech, then lock/recheck the confirmed,
 * future parent before taking the subslot lock. Manual cancellation can commit
 * before the asynchronous cascade; this prevents a stale detail page from
 * creating work in that gap.
 */
async function lockAvailableTechSubslot(
  tx: Tx,
  input: { subslotId: string; techId: string; actor: string },
  options: TechSubslotActionOptions = {},
) {
  const currentTime = () => options.clock?.() ?? new Date();
  const [candidate] = await tx
    .select({
      bookingId: techSubslots.bookingId,
      performerId: bookings.performerId,
      venueId: bookings.venueId,
    })
    .from(techSubslots)
    .innerJoin(bookings, eq(techSubslots.bookingId, bookings.id))
    .where(eq(techSubslots.id, input.subslotId));
  if (!candidate)
    throw new SubslotNotFoundError(`sub-slot ${input.subslotId} not found`);

  await lockActiveProfileOwners(tx, {
    performerIds: [candidate.performerId],
    venueIds: [candidate.venueId],
    techIds: [input.techId],
    additionalUserIds: [input.actor],
  });
  const [parent] = await tx
    .select({ state: bookings.state, terms: bookings.terms })
    .from(bookings)
    .where(eq(bookings.id, candidate.bookingId))
    .for("update");
  if (!parentIsAvailable(parent, currentTime()))
    throw new TechSubslotParentUnavailableError();

  const subslot = await lockTechSubslot(tx, input.subslotId);
  // The request can wait for the subslot after its parent check. Re-read time
  // only once both rows are ours so APPLY and TECH_BOOK cannot commit on or
  // after downbeat. The locked subslot row is the fresh state callers inspect.
  if (!parentIsAvailable(parent, currentTime()))
    throw new TechSubslotParentUnavailableError();
  return { ...subslot, bookingId: candidate.bookingId, parentTerms: parent!.terms };
}

/**
 * Keep one tech's calendar decision atomic across different sound jobs. Exact
 * end/start adjacency is allowed; any positive interval intersection is not.
 */
async function assertTechIsAvailable(
  tx: Tx,
  input: {
    subslotId: string;
    techId: string;
    parentTerms: { startsAt: string; endsAt: string };
  },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`tech-calendar:${input.techId}`}))`,
  );
  const [overlap] = await tx
    .select({ id: techSubslots.id })
    .from(techSubslots)
    .innerJoin(bookings, eq(techSubslots.bookingId, bookings.id))
    .where(
      and(
        eq(techSubslots.techId, input.techId),
        ne(techSubslots.id, input.subslotId),
        eq(techSubslots.state, "booked"),
        eq(bookings.state, "confirmed"),
        sql`(${bookings.terms}->>'startsAt')::timestamptz < ${input.parentTerms.endsAt}::timestamptz`,
        sql`(${bookings.terms}->>'endsAt')::timestamptz > ${input.parentTerms.startsAt}::timestamptz`,
      ),
    )
    .limit(1);
  if (overlap) throw new TechUnavailableError(input.techId, overlap.id);
}

async function throwApplicationError(
  tx: Tx,
  subslotId: string,
  techId: string,
): Promise<never> {
  const [existing] = await tx
    .select({ status: techSubslotApplications.status })
    .from(techSubslotApplications)
    .where(
      and(
        eq(techSubslotApplications.subslotId, subslotId),
        eq(techSubslotApplications.techId, techId),
      ),
    );
  throw new TechSubslotApplicationError(
    existing ? "not_submitted" : "not_found",
  );
}

/** Lock open state, insert the application, and publish its event atomically. */
export async function applyToOpenTechSubslot(input: {
  subslotId: string;
  techId: string;
  actor: string;
  note?: string | null;
}, options: TechSubslotActionOptions = {}): Promise<string> {
  return db().transaction(async (tx) => {
    const subslot = await lockAvailableTechSubslot(tx, input, options);
    if (subslot.state !== "open") throw new TechSubslotNotOpenError();

    const id = newId("application");
    const inserted = await tx
      .insert(techSubslotApplications)
      .values({
        id,
        subslotId: input.subslotId,
        techId: input.techId,
        note: input.note ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: techSubslotApplications.id });
    if (inserted.length === 0)
      throw new TechSubslotApplicationError("duplicate");

    await appendEvent(tx, {
      actor: input.actor,
      kind: "subslot.application",
      subjectType: "tech_subslot",
      subjectId: input.subslotId,
      payload: {
        techId: input.techId,
        effects: [
          {
            kind: "notify",
            template: "subslot_new_application",
            to: "payer",
          },
        ],
      },
    });
    return id;
  });
}

/** Select a still-pending applicant and book the sound job in one transaction. */
export async function bookTechApplicant(input: {
  subslotId: string;
  techId: string;
  actor: string;
}, options: TechSubslotActionOptions = {}): Promise<{
  from: SubslotState;
  to: SubslotState;
}> {
  return db().transaction(async (tx) => {
    // Serialize apply/book/cancel around the sound job before touching an
    // application. A failure later rolls this tentative status change back.
    const subslot = await lockAvailableTechSubslot(tx, input, options);
    if (subslot.state !== "open") throw new TechSubslotNotOpenError();
    await assertTechIsAvailable(tx, {
      subslotId: input.subslotId,
      techId: input.techId,
      parentTerms: subslot.parentTerms,
    });
    const selected = await tx
      .update(techSubslotApplications)
      .set({ status: "booked" })
      .where(
        and(
          eq(techSubslotApplications.subslotId, input.subslotId),
          eq(techSubslotApplications.techId, input.techId),
          eq(techSubslotApplications.status, "submitted"),
        ),
      )
      .returning({ id: techSubslotApplications.id });
    if (selected.length === 0)
      await throwApplicationError(tx, input.subslotId, input.techId);

    const result = await runSubslotTransition(
      input.subslotId,
      { kind: "TECH_BOOKED", techId: input.techId },
      input.actor,
      { tx },
    );
    const declined = await tx
      .update(techSubslotApplications)
      .set({ status: "declined" })
      .where(
        and(
          eq(techSubslotApplications.subslotId, input.subslotId),
          ne(techSubslotApplications.id, selected[0]!.id),
          eq(techSubslotApplications.status, "submitted"),
        ),
      )
      .returning({
        id: techSubslotApplications.id,
        techId: techSubslotApplications.techId,
      });
    for (const application of declined)
      await appendEvent(tx, {
        actor: input.actor,
        kind: "subslot.application_declined",
        subjectType: "tech_subslot",
        subjectId: input.subslotId,
        payload: {
          applicationId: application.id,
          techId: application.techId,
          reason: "another_tech_booked",
          effects: [
            {
              kind: "notify",
              template: "subslot_application_declined",
              to: "applicant",
            },
          ],
        },
      });
    return result;
  });
}

/** Delete only a still-pending application and record the withdrawal atomically. */
export async function withdrawTechSubslotApplication(input: {
  subslotId: string;
  techId: string;
  actor: string;
}, existingTx?: Tx): Promise<void> {
  const apply = async (tx: Tx) => {
    const deleted = await tx
      .delete(techSubslotApplications)
      .where(
        and(
          eq(techSubslotApplications.subslotId, input.subslotId),
          eq(techSubslotApplications.techId, input.techId),
          eq(techSubslotApplications.status, "submitted"),
        ),
      )
      .returning({ id: techSubslotApplications.id });
    if (deleted.length === 0)
      await throwApplicationError(tx, input.subslotId, input.techId);

    await appendEvent(tx, {
      actor: input.actor,
      kind: "subslot.application_withdrawn",
      subjectType: "tech_subslot",
      subjectId: input.subslotId,
      payload: { techId: input.techId },
    });
  };
  if (existingTx) await apply(existingTx);
  else await db().transaction(apply);
}

/** Cascade a parent booking's outcome into its sub-slots (worker fan-out). */
export async function cascadeParentToSubslots(
  bookingId: string,
  parentOutcome: "released" | "cancelled",
  actor: string,
): Promise<void> {
  const rows = await db()
    .select({ id: techSubslots.id })
    .from(techSubslots)
    .where(
      and(
        eq(techSubslots.bookingId, bookingId),
        inArray(techSubslots.state, ACTIVE_SUBSLOT_STATES),
      ),
    );
  for (const row of rows) {
    await db().transaction(async (tx) => {
      const [current] = await tx
        .select({ state: techSubslots.state })
        .from(techSubslots)
        .where(eq(techSubslots.id, row.id))
        .for("update");
      if (
        !current ||
        !(ACTIVE_SUBSLOT_STATES as readonly string[]).includes(current.state)
      )
        return;
      await runSubslotTransition(
        row.id,
        parentOutcome === "released"
          ? current.state === "open"
            ? { kind: "PAYER_CANCELLED" }
            : { kind: "PARENT_RELEASED" }
          : { kind: "PARENT_CANCELLED" },
        actor,
        { tx },
      );
    });
  }
}
