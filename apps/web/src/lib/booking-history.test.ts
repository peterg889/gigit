import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { inArray } from "drizzle-orm";
import { bookingWasConfirmed } from "./booking-history";

describe("booking confirmation history", () => {
  const cancelledOfferId = newId("booking");
  const cancelledBookingId = newId("booking");

  afterAll(async () => {
    await db()
      .delete(schema.events)
      .where(
        inArray(schema.events.subjectId, [cancelledOfferId, cancelledBookingId]),
      );
    await closeDb();
  });

  it("distinguishes pre-confirm and post-confirm cancellation", async () => {
    await db().insert(schema.events).values([
      {
        actor: "test",
        kind: "booking.transition",
        subjectType: "booking",
        subjectId: cancelledOfferId,
        payload: { from: "offered", to: "cancelled_by_venue" },
      },
      {
        actor: "test",
        kind: "booking.transition",
        subjectType: "booking",
        subjectId: cancelledBookingId,
        payload: { from: "confirming", to: "confirmed" },
      },
      {
        actor: "test",
        kind: "booking.transition",
        subjectType: "booking",
        subjectId: cancelledBookingId,
        payload: { from: "confirmed", to: "cancelled_by_performer" },
      },
    ]);

    expect(await bookingWasConfirmed(cancelledOfferId)).toBe(false);
    expect(await bookingWasConfirmed(cancelledBookingId)).toBe(true);
  });
});
