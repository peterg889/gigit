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
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  decideSubslot,
  newId,
  soundPlan,
  type SubslotEvent,
  type SubslotState,
} from "@gigit/domain";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { recordLedgerEntry } from "./ledger.js";
import {
  bookings,
  performers,
  techs,
  techSubslotApplications,
  techSubslots,
  venues,
} from "./schema.js";
import { ConcurrentUpdateError } from "./transition.js";

export class SubslotNotFoundError extends Error {}

/** Create the sub-slot from the parent booking's real context (F6.3). */
export async function createTechSubslot(input: {
  bookingId: string;
  payer: "venue" | "performer";
  budgetCents: number;
  actor: string;
  notes?: string;
}): Promise<string> {
  const d = db();
  const [row] = await d
    .select({ booking: bookings, venue: venues, performer: performers })
    .from(bookings)
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .innerJoin(performers, eq(bookings.performerId, performers.id))
    .where(eq(bookings.id, input.bookingId));
  if (!row) throw new SubslotNotFoundError(`booking ${input.bookingId} not found`);

  const plan = soundPlan(row.venue.paInventory, row.performer.techNeeds);
  const id = newId("slot"); // sub-slots share the slot id space deliberately
  await d.transaction(async (tx) => {
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
  return id;
}

/** One transaction: lock → decide → versioned update → ledger → event. */
export async function runSubslotTransition(
  subslotId: string,
  event: SubslotEvent,
  actor: string,
  now = new Date(),
): Promise<{ from: SubslotState; to: SubslotState }> {
  const d = db();
  return d.transaction(async (tx) => {
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

    await appendEvent(tx, {
      actor,
      kind: "subslot.transition",
      subjectType: "tech_subslot",
      subjectId: subslotId,
      payload: { event: event.kind, from: s.state, to: decision.next, effects: decision.effects },
    });
    return { from: s.state as SubslotState, to: decision.next };
  });
}

/** Cascade a parent booking's outcome into its sub-slots (worker fan-out). */
export async function cascadeParentToSubslots(
  bookingId: string,
  parentOutcome: "released" | "cancelled",
  actor: string,
): Promise<void> {
  const d = db();
  const rows = await d
    .select({ id: techSubslots.id, state: techSubslots.state })
    .from(techSubslots)
    .where(
      and(
        eq(techSubslots.bookingId, bookingId),
        inArray(techSubslots.state, ["open", "booked"]),
      ),
    );
  for (const row of rows) {
    await runSubslotTransition(
      row.id,
      parentOutcome === "released"
        ? row.state === "open"
          ? { kind: "PAYER_CANCELLED" } // gig done, nobody booked — close it
          : { kind: "PARENT_RELEASED" }
        : { kind: "PARENT_CANCELLED" },
      actor,
    );
  }
}
