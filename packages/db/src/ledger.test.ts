import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { bookingLedger } from "./ledger.js";
import { createOffer, runBookingTransition } from "./transition.js";
import { applications, bookings, performers, slots, users, venues } from "./schema.js";

/**
 * THE money invariant (engineering-spec §5): at terminal states,
 * charged == released + refunded. Walks each terminal path on real Postgres.
 */
describe("ledger invariants", () => {
  const userVenue = newId("user");
  const userBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: userVenue, email: `${userVenue}@l.test` },
      { id: userBand, email: `${userBand}@l.test` },
    ]);
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: userVenue,
      kind: "bar",
      name: "Ledger Bar",
      metro: "testville",
      lat: 43,
      lng: -87,
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userBand,
      kind: "band",
      name: "Ledger Band",
      homeMetro: "testville",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function confirmedBooking(amountCents: number, startsInHours: number) {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + startsInHours * 3_600_000);
    await d.insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: amountCents,
    });
    await d.insert(applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms: {
        amountCents,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    return bookingId;
  }

  async function expectBalanced(bookingId: string, expected: {
    charged: number;
    released: number;
    refunded: number;
  }) {
    const l = await bookingLedger(db(), bookingId);
    expect(l).toEqual({
      chargedCents: expected.charged,
      releasedCents: expected.released,
      refundedCents: expected.refunded,
      adjustedCents: 0,
    });
    // Conservation, measured against the booking's OWN terms rather than the
    // literals above. Asserting `charged === released + refunded` right after
    // toEqual pinned all three to those literals could only fail if the test
    // author's arithmetic was wrong — it checked the test, not the code.
    const [b] = await db()
      .select({ terms: bookings.terms })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(l.chargedCents).toBe(b!.terms.amountCents);
    expect(l.releasedCents + l.refundedCents).toBe(b!.terms.amountCents);
  }

  it("full release: charge 500 → release 500", async () => {
    const id = await confirmedBooking(50_000, 24 * 30);
    await runBookingTransition(id, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(id, { kind: "AUTO_CONFIRM_ELAPSED" }, "worker");
    await expectBalanced(id, { charged: 50_000, released: 50_000, refunded: 0 });
  });

  it("venue cancels in the 50% window: fee 250 + refund 250", async () => {
    const id = await confirmedBooking(50_000, 24 * 7); // 7 days out
    await runBookingTransition(id, { kind: "VENUE_CANCELLED" }, userVenue);
    await expectBalanced(id, { charged: 50_000, released: 25_000, refunded: 25_000 });
  });

  it("performer cancels: full refund", async () => {
    const id = await confirmedBooking(50_000, 24);
    await runBookingTransition(id, { kind: "PERFORMER_CANCELLED" }, userBand);
    await expectBalanced(id, { charged: 50_000, released: 0, refunded: 50_000 });
  });

  it("disputed partial: 300 released / 200 refunded", async () => {
    const id = await confirmedBooking(50_000, 24 * 30);
    await runBookingTransition(id, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(
      id,
      { kind: "DISPUTE_OPENED", openedBy: "venue", reason: "cut the set short" },
      userVenue,
    );
    await runBookingTransition(
      id,
      {
        kind: "DISPUTE_RESOLVED",
        resolution: { kind: "partial", releaseCents: 30_000, refundCents: 20_000 },
      },
      "admin",
    );
    await expectBalanced(id, { charged: 50_000, released: 30_000, refunded: 20_000 });
  });

  it("reports explicit adjustments separately from a balanced base settlement", async () => {
    const id = await confirmedBooking(50_000, 24 * 30);
    await runBookingTransition(id, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(id, { kind: "VENUE_CONFIRMED" }, userVenue);
    const { recordLedgerEntry } = await import("./ledger.js");
    await recordLedgerEntry(db(), {
      bookingId: id,
      entryType: "adjustment",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 5_000,
      idempotencyKey: `${id}:adjustment:goodwill-test`,
    });

    const ledger = await bookingLedger(db(), id);
    expect(ledger).toEqual({
      chargedCents: 50_000,
      releasedCents: 50_000,
      refundedCents: 0,
      adjustedCents: 5_000,
    });
    expect(ledger.chargedCents).toBe(
      ledger.releasedCents + ledger.refundedCents,
    );
  });

  it("ledger writes are idempotent (replayed transition effect is a no-op)", async () => {
    const id = await confirmedBooking(50_000, 24 * 30);
    await runBookingTransition(id, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(id, { kind: "VENUE_CONFIRMED" }, userVenue);
    // simulate an outbox replay writing the same intent again
    const { recordLedgerEntry } = await import("./ledger.js");
    await recordLedgerEntry(db(), {
      bookingId: id,
      entryType: "release",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 50_000,
    });
    await expectBalanced(id, { charged: 50_000, released: 50_000, refunded: 0 });
  });
});
