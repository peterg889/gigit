import { TERMINAL_STATES } from "@gigit/domain";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { appendEvent } from "./events.js";
import { applications, bookings, slots } from "./schema.js";

export type SlotCancellationReason =
  | "venue_closed_date"
  | "series_cancelled"
  | "account_deactivated"
  | "account_suspended";

export class SlotCancellationBlockedError extends Error {
  constructor(readonly slotId: string) {
    super(`slot ${slotId} has a live booking`);
    this.name = "SlotCancellationBlockedError";
  }
}

export interface CancelOpenSlotsInput {
  slotIds: readonly string[];
  actor: string;
  reason: SlotCancellationReason;
}

/**
 * Close open dates and resolve their pending applications as one atomic unit.
 *
 * createOffer takes the same slot row lock, so cancellation cannot race a new
 * firm offer. If any requested date already has a non-terminal booking, NONE
 * of the dates or applications change: the venue must wind that booking down
 * first. This is shared by one-off, series, and account-deactivation paths so
 * an act never keeps seeing "Pending" for a date the venue removed.
 */
export async function cancelOpenSlots(
  input: CancelOpenSlotsInput,
  existingTx?: Tx,
): Promise<number> {
  const slotIds = [...new Set(input.slotIds)];
  if (slotIds.length === 0) return 0;

  const apply = async (tx: Tx): Promise<number> => {
    // Stable ordering avoids two bulk cancellations deadlocking when their
    // date sets overlap.
    const locked = await tx
      .select({ id: slots.id, status: slots.status })
      .from(slots)
      .where(inArray(slots.id, slotIds))
      .orderBy(slots.id)
      .for("update");
    const openIds = locked
      .filter((slot) => slot.status === "open")
      .map((slot) => slot.id);
    if (openIds.length === 0) return 0;

    const [activeBooking] = await tx
      .select({ slotId: bookings.slotId })
      .from(bookings)
      .where(
        and(
          inArray(bookings.slotId, openIds),
          notInArray(bookings.state, [...TERMINAL_STATES]),
        ),
      )
      .limit(1);
    if (activeBooking)
      throw new SlotCancellationBlockedError(activeBooking.slotId);

    const resolved = await tx
      .update(applications)
      .set({ status: "declined", declineReason: "slot_cancelled" })
      .where(
        and(
          inArray(applications.slotId, openIds),
          eq(applications.status, "submitted"),
        ),
      )
      .returning({ id: applications.id, slotId: applications.slotId });

    await tx
      .update(slots)
      .set({ status: "cancelled" })
      .where(and(inArray(slots.id, openIds), eq(slots.status, "open")));

    for (const application of resolved)
      await appendEvent(tx, {
        actor: input.actor,
        kind: "application.declined",
        subjectType: "slot",
        subjectId: application.slotId,
        payload: {
          applicationId: application.id,
          reason: "slot_cancelled",
          effects: [
            {
              kind: "notify",
              template: "application_cancelled",
              to: "performer",
            },
          ],
        },
      });

    for (const slotId of openIds)
      await appendEvent(tx, {
        actor: input.actor,
        kind: "slot.cancelled",
        subjectType: "slot",
        subjectId: slotId,
        payload: { reason: input.reason },
      });

    return openIds.length;
  };

  return existingTx ? apply(existingTx) : db().transaction(apply);
}
