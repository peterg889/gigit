import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { createInvitedOffer } from "./invites.js";
import { applications, bookings, slots } from "./schema.js";
import { makePerformer, makeVenue } from "./test/factories.js";
import { createOffer, SlotUnavailableError } from "./transition.js";

describe("atomic invited-offer preparation", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("rolls back both a synthetic and a revived application when the offer conflicts", async () => {
    const venue = await makeVenue({ name: "Atomic Rebook Room" });
    const holder = await makePerformer({ name: "Current Offer Holder" });
    const freshTarget = await makePerformer({ name: "Fresh Rebook Target" });
    const revivedTarget = await makePerformer({ name: "Revived Rebook Target" });
    const startsAt = new Date(Date.now() + 21 * 86_400_000);
    const slotId = newId("slot");
    await db().insert(slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "atomic-rebook",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 36_000,
    });
    const holderApplicationId = newId("application");
    await db().insert(applications).values({
      id: holderApplicationId,
      slotId,
      performerId: holder.id,
    });
    const terms = {
      amountCents: 36_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 120 * 60_000).toISOString(),
    };
    await createOffer({
      applicationId: holderApplicationId,
      slotId,
      performerId: holder.id,
      venueId: venue.id,
      actor: venue.ownerUserId,
      terms,
    });

    await expect(
      createInvitedOffer({
        slotId,
        performerId: freshTarget.id,
        venueId: venue.id,
        actor: venue.ownerUserId,
        terms,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    const synthetic = await db()
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.slotId, slotId),
          eq(applications.performerId, freshTarget.id),
        ),
      );
    expect(synthetic).toHaveLength(0);

    const revivedApplicationId = newId("application");
    await db().insert(applications).values({
      id: revivedApplicationId,
      slotId,
      performerId: revivedTarget.id,
      status: "declined",
      declineReason: "slot_filled",
      note: "Preserve this prior application.",
    });
    await expect(
      createInvitedOffer({
        slotId,
        performerId: revivedTarget.id,
        venueId: venue.id,
        actor: venue.ownerUserId,
        terms,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    const [revived] = await db()
      .select({
        status: applications.status,
        declineReason: applications.declineReason,
        note: applications.note,
      })
      .from(applications)
      .where(eq(applications.id, revivedApplicationId));
    expect(revived).toEqual({
      status: "declined",
      declineReason: "slot_filled",
      note: "Preserve this prior application.",
    });

    const liveBookings = await db()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.slotId, slotId));
    expect(liveBookings).toHaveLength(1);
  });
});
