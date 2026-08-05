import { newId } from "@gigit/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { reconcileMoney } from "./reconcile.js";
import { recordLedgerEntry } from "./ledger.js";
import { applications, bookings, performers, slots, users, venues } from "./schema.js";

/**
 * M1 exit criterion: "reconciliation catches seeded faults." The fixtures
 * distinguish contractual settlement from explicit, additional admin money
 * movements so one cannot hide corruption in the other.
 */
describe("money reconciliation (seeded faults)", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const balanced = newId("booking");
  const shortSettled = newId("booking");
  const orphanSettled = newId("booking");
  const adjustedToBalance = newId("booking");
  const balancedWithGoodwill = newId("booking");
  const feeAndRefund = newId("booking");
  const adjustmentOnly = newId("booking");

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

    // An extra adjustment must never conceal a short BASE settlement. The
    // booking still owes 3,000 on its contractual release even though ops sent
    // a separate 3,000 goodwill transfer.
    await mkBooking(adjustedToBalance, "released");
    await recordLedgerEntry(d, {
      bookingId: adjustedToBalance, entryType: "charge",
      debitParty: `venue:${venueId}`, creditParty: "platform", amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: adjustedToBalance, entryType: "release",
      debitParty: "platform", creditParty: `performer:${performerId}`, amountCents: 7_000,
    });
    await recordLedgerEntry(d, {
      bookingId: adjustedToBalance, entryType: "adjustment",
      debitParty: "platform", creditParty: `performer:${performerId}`, amountCents: 3_000,
      idempotencyKey: `${adjustedToBalance}:adjustment:test`,
    });


    // Conversely, a fully settled booking remains clean after an explicit
    // additional goodwill payment. Adjustments are accounted for, but outside
    // the charge == base release/refund/fee conservation equation.
    await mkBooking(balancedWithGoodwill, "released");
    await recordLedgerEntry(d, {
      bookingId: balancedWithGoodwill,
      entryType: "charge",
      debitParty: `venue:${venueId}`,
      creditParty: "platform",
      amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: balancedWithGoodwill,
      entryType: "release",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: balancedWithGoodwill,
      entryType: "adjustment",
      debitParty: "platform",
      creditParty: `performer:${performerId}`,
      amountCents: 3_000,
      idempotencyKey: `${balancedWithGoodwill}:adjustment:test`,
    });
    // A cancellation settles as fee + refund, which must also balance.
    await mkBooking(feeAndRefund, "cancelled_by_venue");
    await recordLedgerEntry(d, {
      bookingId: feeAndRefund, entryType: "charge",
      debitParty: `venue:${venueId}`, creditParty: "platform", amountCents: 10_000,
    });
    await recordLedgerEntry(d, {
      bookingId: feeAndRefund, entryType: "fee",
      debitParty: "platform", creditParty: `performer:${performerId}`, amountCents: 5_000,
    });
    await recordLedgerEntry(d, {
      bookingId: feeAndRefund, entryType: "refund",
      debitParty: "platform", creditParty: `venue:${venueId}`, amountCents: 5_000,
    });

    // An adjustment with NO charge behind it: money credited out of nowhere.
    // This is the shape a mistyped admin correction takes.
    await mkBooking(adjustmentOnly, "released");
    await recordLedgerEntry(d, {
      bookingId: adjustmentOnly, entryType: "adjustment",
      debitParty: "platform", creditParty: `performer:${performerId}`, amountCents: 4_000,
      idempotencyKey: `${adjustmentOnly}:adjustment:test`,
    });

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

    // A short base release cannot be laundered into balance by an adjustment.
    const maskedShortfall = byBooking(adjustedToBalance);
    expect(maskedShortfall.some((m) => m.kind === "unbalanced_terminal")).toBe(true);
    expect(maskedShortfall[0]?.detail).toMatchObject({
      charged: 10_000,
      settled: 7_000,
    });

    expect(byBooking(balancedWithGoodwill)).toHaveLength(0);

    // A cancellation's fee + refund also balances against the charge.
    expect(byBooking(feeAndRefund)).toHaveLength(0);

    // ...but an adjustment with nothing charged behind it is still money from
    // nowhere, and must not be laundered into looking balanced.
    expect(byBooking(adjustmentOnly).length).toBeGreaterThan(0);
  });
});
