import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import {
  actorRoles,
  bookings,
  ledgerEntries,
  performers,
  reviews,
  slots,
  users,
  venues,
} from "./schema.js";
import { E2E_JOURNEYS } from "./seed-fixtures.js";
import { ensurePostGigE2EJourney } from "./seed-postgig.js";

describe("post-gig E2E seed", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("is idempotent and restores one valid past awaiting-confirmation booking", async () => {
    const now = new Date("2030-06-15T12:00:00.000Z");
    const first = await ensurePostGigE2EJourney(db(), now);
    const second = await ensurePostGigE2EJourney(db(), now);
    expect(second).toEqual(first);

    const journey = E2E_JOURNEYS.postgig;
    const fixtureUsers = await db()
      .select()
      .from(users)
      .where(
        inArray(users.email, [
          journey.venue.email,
          journey.performer.email,
          journey.admin.email,
        ]),
      );
    expect(fixtureUsers).toHaveLength(3);
    expect(fixtureUsers.every(({ status }) => status === "active")).toBe(true);

    expect(
      await db()
        .select({ id: venues.id, status: venues.status })
        .from(venues)
        .where(eq(venues.id, first.venueId)),
    ).toEqual([{ id: first.venueId, status: "live" }]);
    expect(
      await db()
        .select({ id: performers.id, status: performers.status })
        .from(performers)
        .where(eq(performers.id, first.performerId)),
    ).toEqual([{ id: first.performerId, status: "live" }]);
    expect(
      await db()
        .select({ id: actorRoles.id })
        .from(actorRoles)
        .where(
          and(
            eq(actorRoles.userId, first.adminUserId),
            eq(actorRoles.kind, "admin"),
          ),
        ),
    ).toHaveLength(1);

    const fixtureSlots = await db()
      .select()
      .from(slots)
      .where(eq(slots.notes, journey.booking.marker));
    expect(fixtureSlots).toHaveLength(1);
    expect(fixtureSlots[0]?.status).toBe("filled");

    const fixtureBookings = await db()
      .select()
      .from(bookings)
      .where(eq(bookings.id, first.bookingId));
    expect(fixtureBookings).toHaveLength(1);
    const booking = fixtureBookings[0]!;
    expect(booking.state).toBe("awaiting_confirmation");
    expect(booking.terms.amountCents).toBe(journey.booking.amountCents);
    expect(booking.terms.notes).toBe(journey.booking.marker);
    expect(new Date(booking.terms.endsAt).getTime()).toBeLessThan(now.getTime());

    expect(
      await db()
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.bookingId, first.bookingId)),
    ).toMatchObject([
      {
        entryType: "charge",
        amountCents: journey.booking.amountCents,
        paymentRef: "null_e2e_postgig",
      },
    ]);
    expect(
      await db()
        .select()
        .from(reviews)
        .where(eq(reviews.bookingId, first.bookingId)),
    ).toHaveLength(0);
  });
});
