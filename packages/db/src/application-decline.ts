/**
 * The one way the booking rail closes out *pending* applications in bulk.
 *
 * Four paths do this (slot filled, slot expired at downbeat, the past-slot
 * sweep, slot cancellation) and each one used to hand-roll the same
 * update-then-append pair. They drifted: the bulk "slot filled" path declined
 * the losing applicants but emitted no event at all, so most acts never heard
 * back. Keeping the write and its outbox event in one place is what stops that
 * from happening again.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "./client.js";
import { appendEvent } from "./events.js";
import { applications } from "./schema.js";

/**
 * Persisted, indexed business state — NOT notification copy. `slot_filled` in
 * particular is what the reopen path keys on to revive exactly the passed-over
 * applicants (transition.ts, `slot.applicants_revived`), so it must survive on
 * the row. The notification template is derived from it below.
 */
export type ApplicationDeclineReason =
  | "slot_filled"
  | "slot_expired"
  | "slot_cancelled";

const DECLINE_TEMPLATE: Record<ApplicationDeclineReason, string> = {
  slot_filled: "application_declined",
  slot_expired: "application_expired",
  slot_cancelled: "application_cancelled",
};

export interface DeclinePendingApplicationsInput {
  slotIds: readonly string[];
  actor: string;
  reason: ApplicationDeclineReason;
  /** The winning/offered act, whose own application is resolved separately. */
  excludePerformerId?: string;
}

/**
 * Decline every still-`submitted` application on the given slots and tell each
 * act. Only `submitted` rows are touched — an `offered` application belongs to
 * its booking's own transition, and resolving it here would double-notify the
 * same offer.
 *
 * Must run inside the caller's transaction: the decline and its outbox event
 * have to commit with the slot state change that caused them.
 */
export async function declinePendingApplications(
  tx: Tx,
  input: DeclinePendingApplicationsInput,
): Promise<{ id: string; slotId: string }[]> {
  const slotIds = [...input.slotIds];
  if (slotIds.length === 0) return [];

  const declined = await tx
    .update(applications)
    .set({ status: "declined", declineReason: input.reason })
    .where(
      and(
        inArray(applications.slotId, slotIds),
        eq(applications.status, "submitted"),
        ...(input.excludePerformerId
          ? [ne(applications.performerId, input.excludePerformerId)]
          : []),
      ),
    )
    .returning({ id: applications.id, slotId: applications.slotId });

  for (const application of declined)
    await appendEvent(tx, {
      actor: input.actor,
      kind: "application.declined",
      subjectType: "slot",
      subjectId: application.slotId,
      payload: {
        applicationId: application.id,
        reason: input.reason,
        effects: [
          {
            kind: "notify",
            template: DECLINE_TEMPLATE[input.reason],
            to: "performer",
          },
        ],
      },
    });

  return declined;
}
