import { newId } from "@gigit/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { reconcileMoney } from "./reconcile.js";
import { recordLedgerEntry } from "./ledger.js";
import { applications, bookings, performers, slots, users, venues } from "./schema.js";

/**
 * M1 exit criterion: "reconciliation catches seeded faults." We seed three
 * bookings — one balanced, one short-settled, one with a settlement and no
 * charge — and assert exactly the right two are flagged.
 */
describe("money reconciliation (seeded faults)", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const balanced = newId("booking");
  const shortSettled = newId("booking");
  const orphanSettled = newId("booking");

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values({ id: userId, email: `${userId}@t.test` });
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: userId,
      kind: "bar",
      name: "Reconcile Test Bar",
      metro: "testville",
      lat: 43,
      lng: -88,
      paInventory: { hasPA: true },
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "solo",
      name: "Reconcile Test Act",
      homeMetro: "testville",
      techNeeds: { inputs: 1 },
    });
    const mkBooking = async (id: string, state: string) => {
      const slotId = newId("slot");
      await d.insert(slots).values({
        id: slotId,
        venueId,
        metro: "testville",
        startsAt: new Date(Date.now() + 86_400_000),
        durationMinutes: 60,
        format: "music",
        budgetCents: 10_000,
        status: "filled",
      });
      const appId = newId("application");
      await d.insert(applications).values({ id: appId, slotId, performerId, status: "offered" });
      await d.insert(bookings).values({
        id,
        slotId,
        performerId,
        venueId,
        state,
        terms: {
          amountCents: 10_000,
          startsAt: new Date().toISOString(),
          endsAt: new Date().toISOString(),
        },
        offerExpiresAt: new Date(Date.now() + 72 * 3_600_000),
        agreementTemplateVer: "v1",
      });
    };

    // balanced: charge 10000, release 10000
    await mkBooking(balanced, "released");
    await recordLedgerEntry(d, {
      bookingId: balanced,
      entryType: "charge",
      debitParty: `venue:${venueId}`,
      creditParty: "platform",
      amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: balanced,
      entryType: "release",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 10_000,
    });

    // fault 1: terminal but only half settled
    await mkBooking(shortSettled, "released");
    await recordLedgerEntry(d, {
      bookingId: shortSettled,
      entryType: "charge",
      debitParty: `venue:${venueId}`,
      creditParty: "platform",
      amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: shortSettled,
      entryType: "release",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 5_000,
    });

    // fault 2: a refund with no charge ever recorded
    await mkBooking(orphanSettled, "refunded");
    await recordLedgerEntry(d, {
      bookingId: orphanSettled,
      entryType: "refund",
      debitParty: "platform",
      creditParty: `venue:${venueId}`,
      amountCents: 10_000,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("flags exactly the seeded faults and not the balanced booking", async () => {
    const mismatches = await reconcileMoney();
    const byBooking = (id: string) => mismatches.filter((m) => m.bookingId === id);

    expect(byBooking(balanced)).toHaveLength(0);

    const short = byBooking(shortSettled);
    expect(short.some((m) => m.kind === "unbalanced_terminal")).toBe(true);
    expect(short[0]?.detail).toMatchObject({ charged: 10_000, settled: 5_000 });

    const orphan = byBooking(orphanSettled);
    expect(orphan.some((m) => m.kind === "settlement_without_charge")).toBe(true);
  });
});
