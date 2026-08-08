/**
 * Account exit lifecycle (PRD F9.x). Marketplace records remain — completed
 * bookings, reviews, disputes, and audit history must not become misleading —
 * but an inactive party's actionable commitments cannot be left dangling.
 * Deactivation and suspension therefore share one transition-driven wind-down,
 * including normal counterparty cancellation notices. Deactivation then removes
 * login identifiers; suspension retains a read-only, reinstatable identity.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { IllegalSubslotTransitionError, type BookingEvent } from "@gigit/domain";
import type { Db, Tx } from "./client.js";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { cancelSeries } from "./series.js";
import { cancelOpenSlots } from "./slot-cancellation.js";
import {
  runSubslotTransition,
  SubslotAssigneeChangedError,
  SubslotNotFoundError,
  TechSubslotParentUnavailableError,
  TechSubslotApplicationError,
  withdrawTechSubslotApplication,
} from "./subslots.js";
import {
  BookingNotFoundError,
  ConcurrentUpdateError,
  IllegalTransitionError,
  runBookingTransition,
} from "./transition.js";
import {
  blockedIdentifiers,
  applications,
  bookings,
  performers,
  slots,
  slotSeries,
  techs,
  techSubslotApplications,
  users,
  techSubslots,
  venues,
} from "./schema.js";

/**
 * Take a person's public presence down (or put it back). Profiles are the
 * public face of an account: a venue publishes a full street address, an act
 * publishes an EPK. When the account stops being active — the person left, or
 * an admin suspended them — those pages and every directory must stop serving
 * them. Shared by deactivation and admin suspend/reinstate so the two can
 * never drift apart.
 */
export async function setProfileVisibility(
  userId: string,
  status: "live" | "hidden" | "suspended",
  existingTx?: Tx,
): Promise<void> {
  // Every role table this account can publish through. The order is fixed
  // (performers → venues → techs) because the restore branch below takes a row
  // lock in each one: two concurrent visibility changes on the same account
  // must queue rather than deadlock holding one table while waiting on another.
  const PROFILE_TABLES = [performers, venues, techs] as const;

  const apply = async (tx: Tx) => {
    if (status === "hidden") {
      // Hiding also has to catch `suspended` rows: a deactivating account may
      // already be suspended, and those profiles must come down too.
      for (const table of PROFILE_TABLES)
        await tx
          .update(table)
          .set({ status })
          .where(
            and(
              eq(table.ownerUserId, userId),
              inArray(table.status, ["live", "suspended"]),
            ),
          );
      return;
    }

    if (status === "suspended") {
      // Only `live` rows move here. Sweeping hidden/archived rows into
      // `suspended` would make them eligible for the restore pick below and
      // republish a profile the owner had deliberately taken down.
      for (const table of PROFILE_TABLES)
        await tx
          .update(table)
          .set({ status })
          .where(and(eq(table.ownerUserId, userId), eq(table.status, "live")));
      return;
    }

    // Restore the precise profile an admin suspended, never an older archived
    // profile. Existing-live is next (idempotency), and hidden is a final,
    // deterministic fallback for accounts suspended before the dedicated
    // `suspended` profile status existed.
    const restored: (string | undefined)[] = [];
    for (const table of PROFILE_TABLES) {
      const [row] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.ownerUserId, userId),
            inArray(table.status, ["suspended", "live", "hidden"]),
          ),
        )
        .orderBy(
          desc(eq(table.status, "suspended")),
          desc(eq(table.status, "live")),
          asc(table.createdAt),
          asc(table.id),
        )
        .limit(1)
        .for("update");
      restored.push(row?.id);
    }

    // Demote first, promote second: the partial unique index allows only one
    // live row per owner per role, so the previously live/suspended siblings
    // have to be out of the way before the chosen row goes live.
    for (const table of PROFILE_TABLES)
      await tx
        .update(table)
        .set({ status: "hidden" })
        .where(
          and(
            eq(table.ownerUserId, userId),
            inArray(table.status, ["live", "suspended"]),
          ),
        );
    for (const [index, table] of PROFILE_TABLES.entries()) {
      const id = restored[index];
      if (id)
        await tx.update(table).set({ status: "live" }).where(eq(table.id, id));
    }
  };

  if (existingTx) await apply(existingTx);
  else await db().transaction(apply);
}

type BookingParty = "performer" | "venue";
export type AccountExitReason = "account_deactivated" | "account_suspended";

function accountExitEvent(
  state: string,
  party: BookingParty,
  reason: AccountExitReason,
): BookingEvent | null {
  if (state === "confirming")
    return { kind: "PAYMENT_FAILED", reason };
  if (state === "offered")
    return { kind: party === "performer" ? "PERFORMER_DECLINED" : "VENUE_CANCELLED" };
  if (state === "confirmed")
    return { kind: party === "performer" ? "PERFORMER_CANCELLED" : "VENUE_CANCELLED" };
  return null;
}

/**
 * Wind down one booking based on its CURRENT state.
 *
 * The initial account query is only a work list: an offered booking can move
 * to confirming/confirmed before its turn. Re-fetch and retry the appropriate
 * event instead of swallowing IllegalTransitionError and making the account
 * inactive while a charge-capable booking survives underneath it.
 */
type WindDownHooks = {
  /** @internal Deterministic seam for exercising a state change between read and write. */
  beforeTransition?: (state: string, attempt: number) => Promise<void>;
};

/** @internal Exported so the integration suite can force a transition race. */
export async function windDownBookingForAccountExit(
  bookingId: string,
  party: BookingParty,
  actor: string,
  reason: AccountExitReason,
  hooks?: WindDownHooks,
  existingTx?: Tx,
): Promise<void> {
  // Booking states only move forward, so this normally needs one attempt and
  // can cross at most offered → confirming → confirmed under races.
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = existingTx ?? db();
    const [current] = await d
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    if (!current) return;
    const event = accountExitEvent(current.state, party, reason);
    if (!event) return;
    await hooks?.beforeTransition?.(current.state, attempt);
    try {
      await runBookingTransition(
        bookingId,
        event,
        actor,
        new Date(),
        existingTx,
      );
      return;
    } catch (e) {
      if (e instanceof BookingNotFoundError) return;
      if (
        e instanceof IllegalTransitionError ||
        e instanceof ConcurrentUpdateError
      )
        continue;
      throw e;
    }
  }
  throw new Error(`booking ${bookingId} kept moving during account exit`);
}

export type AccountWindDownHooks = {
  /** @internal Fires while the active user row is locked, before worklists. */
  afterAccountLock?: () => Promise<void>;
  /** @internal Fires after the account's series rows are locked. */
  afterSeriesLock?: () => Promise<void>;
  /** @internal Deterministic seam for changing an assignment after the worklist read. */
  beforeTechTransition?: (
    subslotId: string,
    expectedTechId: string,
  ) => Promise<void>;
  /** @internal Deterministic seam for stale pending-application worklists. */
  beforeTechApplicationWithdrawal?: (
    subslotId: string,
    techId: string,
  ) => Promise<void>;
};

async function windDownAccountCommitments(
  userId: string,
  actor: string,
  reason: AccountExitReason,
  tx: Tx,
  hooks?: AccountWindDownHooks,
): Promise<boolean> {
  let changed = false;

  const ownedPerformers = await tx
    .select({ id: performers.id, status: performers.status })
    .from(performers)
    .where(eq(performers.ownerUserId, userId));
  const ownedVenues = await tx
    .select({ id: venues.id, status: venues.status })
    .from(venues)
    .where(eq(venues.ownerUserId, userId));
  if (ownedPerformers.some((profile) => profile.status === "live"))
    changed = true;
  if (ownedVenues.some((profile) => profile.status === "live"))
    changed = true;
  const venueIds = ownedVenues.map((profile) => profile.id);

  // Series cancellation uses series → slots. Take every series lock in a
  // stable order before any booking transition can lock a slot, so a normal
  // series cancellation can never hold the series while waiting on a slot
  // that this transaction holds while waiting on that same series.
  const activeSeries =
    venueIds.length > 0
      ? await tx
          .select({ id: slotSeries.id })
          .from(slotSeries)
          .where(
            and(
              inArray(slotSeries.venueId, venueIds),
              eq(slotSeries.status, "active"),
            ),
          )
          .orderBy(asc(slotSeries.id))
          .for("update")
      : [];
  await hooks?.afterSeriesLock?.();
  if (activeSeries.length > 0) changed = true;

  // Actionable commitments end through the state machine so slots reopen,
  // timers cancel, and counterparties are notified. Gigs already played and
  // open disputes keep their flows; account status does not decide money.
  if (ownedPerformers.length > 0) {
    const performerIds = ownedPerformers.map((profile) => profile.id);
    const live = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          inArray(bookings.performerId, performerIds),
          inArray(bookings.state, ["offered", "confirming", "confirmed"]),
        ),
      );
    if (live.length > 0) changed = true;
    for (const booking of live)
      await windDownBookingForAccountExit(
        booking.id,
        "performer",
        actor,
        reason,
        undefined,
        tx,
      );
    const withdrawn = await tx
      .update(applications)
      .set({ status: "withdrawn" })
      .where(
        and(
          inArray(applications.performerId, performerIds),
          eq(applications.status, "submitted"),
        ),
      )
      .returning({ id: applications.id });
    if (withdrawn.length > 0) changed = true;
  }

  if (venueIds.length > 0) {
    const live = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          inArray(bookings.venueId, venueIds),
          inArray(bookings.state, ["offered", "confirming", "confirmed"]),
        ),
      );
    if (live.length > 0) changed = true;
    for (const booking of live)
      await windDownBookingForAccountExit(
        booking.id,
        "venue",
        actor,
        reason,
        undefined,
        tx,
      );

    for (const series of activeSeries)
      await cancelSeries(series.id, actor, tx);

    // Remaining open slots (including ones the cancellations above reopened)
    // stop collecting applications nobody will ever read.
    const open = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(
        and(inArray(slots.venueId, venueIds), eq(slots.status, "open")),
      );
    if (open.length > 0) {
      changed = true;
      await cancelOpenSlots(
        {
          slotIds: open.map((slot) => slot.id),
          actor,
          reason,
        },
        tx,
      );
    }
  }

  // A departing tech's booked work reopens through the state machine, and
  // their still-pending applications disappear in this same transaction.
  const ownedTechs = await tx
    .select({ id: techs.id, status: techs.status })
    .from(techs)
    .where(eq(techs.ownerUserId, userId));
  if (ownedTechs.some((profile) => profile.status === "live"))
    changed = true;
  if (ownedTechs.length > 0) {
    const techIds = ownedTechs.map((profile) => profile.id);
    const booked = await tx
      .select({ id: techSubslots.id, techId: techSubslots.techId })
      .from(techSubslots)
      .where(
        and(
          inArray(techSubslots.techId, techIds),
          eq(techSubslots.state, "booked"),
        ),
      );
    if (booked.length > 0) changed = true;
    for (const sub of booked) {
      if (!sub.techId) continue;
      await hooks?.beforeTechTransition?.(sub.id, sub.techId);
      try {
        await runSubslotTransition(
          sub.id,
          { kind: "TECH_CANCELLED" },
          actor,
          { expectedTechId: sub.techId, tx },
        );
      } catch (e) {
        // A row that moved or disappeared after the worklist read is already
        // wound down. Database, ledger, and outbox failures still roll back
        // the entire account exit.
        if (
          e instanceof IllegalSubslotTransitionError ||
          e instanceof ConcurrentUpdateError ||
          e instanceof SubslotNotFoundError ||
          e instanceof SubslotAssigneeChangedError ||
          // The parent has closed or downbeat passed, so reopening this
          // assignment is no longer a valid account-exit side effect.
          e instanceof TechSubslotParentUnavailableError
        )
          continue;
        throw e;
      }
    }

    const pendingApplications = await tx
      .select({
        subslotId: techSubslotApplications.subslotId,
        techId: techSubslotApplications.techId,
      })
      .from(techSubslotApplications)
      .where(
        and(
          inArray(techSubslotApplications.techId, techIds),
          eq(techSubslotApplications.status, "submitted"),
        ),
      );
    if (pendingApplications.length > 0) changed = true;
    for (const application of pendingApplications) {
      await hooks?.beforeTechApplicationWithdrawal?.(
        application.subslotId,
        application.techId,
      );
      try {
        await withdrawTechSubslotApplication(
          {
            subslotId: application.subslotId,
            techId: application.techId,
            actor,
          },
          tx,
        );
      } catch (e) {
        // The worklist is intentionally optimistic. A parent cascade may
        // decline the row, or a simultaneous manual withdrawal may delete it,
        // before this turn. Those two outcomes are already resolved; event or
        // database failures must still roll back the whole deactivation.
        if (
          e instanceof TechSubslotApplicationError &&
          (e.reason === "not_found" || e.reason === "not_submitted")
        )
          continue;
        throw e;
      }
    }
  }

  return changed;
}

export type SuspendAccountResult =
  | "updated"
  | "unchanged"
  | "not_found"
  | "invalid_transition";

/**
 * Suspend an account and remove every still-actionable marketplace commitment
 * before its identity/profile gates become read-only. The user row lock is the
 * shared creator gate: work committed before it is swept; work attempted after
 * it observes `suspended` and cannot be created.
 */
export async function suspendAccount(
  userId: string,
  actor: string,
  hooks?: AccountWindDownHooks,
): Promise<SuspendAccountResult> {
  return db().transaction(async (tx) => {
    const [account] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!account) return "not_found";
    if (account.status !== "active" && account.status !== "suspended")
      return "invalid_transition";
    const repairingLegacySuspension = account.status === "suspended";
    await hooks?.afterAccountLock?.();

    const lifecycleChanged = await windDownAccountCommitments(
      userId,
      actor,
      "account_suspended",
      tx,
      hooks,
    );
    if (!repairingLegacySuspension)
      await tx
        .update(users)
        .set({ status: "suspended" })
        .where(eq(users.id, userId));
    await setProfileVisibility(userId, "suspended", tx);

    // Reissuing suspension is normally idempotent, but it also provides a safe
    // repair path for rows suspended before commitment wind-down existed.
    if (repairingLegacySuspension && !lifecycleChanged) return "unchanged";
    await appendEvent(tx, {
      actor,
      kind: "user.suspended",
      subjectType: "user",
      subjectId: userId,
      payload: {
        commitmentsWoundDown: true,
        ...(repairingLegacySuspension ? { repaired: true } : {}),
      },
    });
    return "updated";
  });
}

export async function deactivateAccount(
  userId: string,
  hooks?: AccountWindDownHooks,
): Promise<void> {
  await db().transaction(async (tx) => {
    const [account] = await tx
      // email/phone come along because they are about to be nulled and the
      // suspension blocklist needs them first.
      .select({ status: users.status, email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!account || account.status === "deleted") return;
    await hooks?.afterAccountLock?.();

    await windDownAccountCommitments(
      userId,
      userId,
      "account_deactivated",
      tx,
      hooks,
    );
    // A suspension has to outlive the account. Self-deactivation is allowed
    // even while suspended — people get to leave — but the identifiers are
    // about to be nulled, and auth/verify recognizes a returning user BY those
    // identifiers. Without this, a suspended user holding a valid session could
    // delete and immediately re-register on the same address as a clean
    // account, erasing the only moderation lever the product has.
    if (account.status === "suspended") {
      const blocked = [account.email, account.phone]
        .filter((v): v is string => !!v)
        .map((identifier) => ({
          identifierHash: hashIdentifier(identifier),
          reason: "suspended",
          sourceUserId: userId,
        }));
      if (blocked.length > 0)
        await tx
          .insert(blockedIdentifiers)
          .values(blocked)
          .onConflictDoNothing();
    }

    await tx
      .update(users)
      .set({
        status: "deleted",
        email: null,
        phone: null,
        smsOptedOutAt: new Date(),
      })
      .where(eq(users.id, userId));
    // Unpublish in the same transaction as the account change — otherwise a
    // deactivated venue's street address stays public indefinitely.
    await setProfileVisibility(userId, "hidden", tx);
    await appendEvent(tx, {
      actor: userId,
      kind: "user.deactivated",
      subjectType: "user",
      subjectId: userId,
    });
  });
}

/**
 * Normalize then hash a sign-in identifier.
 *
 * Deactivation exists to stop us holding the address, so the blocklist stores a
 * digest rather than the value — enough to answer "was this suspended before?"
 * and nothing more. Normalization matches auth/verify's lookup (addresses are
 * compared case-sensitively there today, so lowercase both sides here rather
 * than letting Foo@x.com walk past a block on foo@x.com).
 */
export function hashIdentifier(identifier: string): string {
  return createHash("sha256")
    .update(identifier.trim().toLocaleLowerCase("en-US"))
    .digest("hex");
}

/** True when this identifier belongs to an account that was suspended. */
export async function identifierIsBlocked(
  identifier: string,
  d: Db | Tx = db(),
): Promise<boolean> {
  const [row] = await d
    .select({ hash: blockedIdentifiers.identifierHash })
    .from(blockedIdentifiers)
    .where(eq(blockedIdentifiers.identifierHash, hashIdentifier(identifier)));
  return !!row;
}
