import { describe, expect, it } from "vitest";
import { performerCancellationFee, venueCancellationFee } from "./cancellation.js";

/**
 * The only percentage split in the product, and it had no test file. Every money
 * literal elsewhere in the suite is a whole dollar, so `Math.round(amountCents / 2)`
 * was never exercised on an odd cent — conservation held only because the second
 * leg is derived by subtraction, which a refactor computing both legs
 * independently would quietly break (minting or losing one cent per cancellation).
 */
describe("venue cancellation fee schedule", () => {
  const gig = new Date("2026-08-01T20:00:00Z");
  const hoursBefore = (h: number) => new Date(gig.getTime() - h * 3_600_000);

  describe("the three windows", () => {
    const AMOUNT = 30_000;
    it("more than 14 days out: nothing owed, full refund", () => {
      expect(venueCancellationFee(AMOUNT, gig, hoursBefore(15 * 24))).toEqual({
        feeCents: 0,
        refundCents: AMOUNT,
      });
    });

    it("exactly 14 days out is already the 50% window (boundary is > 14 days)", () => {
      expect(venueCancellationFee(AMOUNT, gig, hoursBefore(14 * 24))).toEqual({
        feeCents: 15_000,
        refundCents: 15_000,
      });
    });

    it("exactly 48 hours out is still the 50% window (boundary is >= 48h)", () => {
      expect(venueCancellationFee(AMOUNT, gig, hoursBefore(48))).toEqual({
        feeCents: 15_000,
        refundCents: 15_000,
      });
    });

    it("just inside 48 hours: the act is owed the whole fee", () => {
      expect(venueCancellationFee(AMOUNT, gig, hoursBefore(47.9))).toEqual({
        feeCents: AMOUNT,
        refundCents: 0,
      });
    });

    it("after the gig has already started, the act is still owed in full", () => {
      expect(venueCancellationFee(AMOUNT, gig, hoursBefore(-3))).toEqual({
        feeCents: AMOUNT,
        refundCents: 0,
      });
    });
  });

  describe("odd cents in the 50% window", () => {
    // Where the rounding actually bites. The odd cent must land on exactly one
    // side and the two legs must still sum to the amount charged.
    const cases: [number, number, number][] = [
      // amount, expected fee, expected refund
      [1, 1, 0], // rounds up to the act
      [3, 2, 1],
      [99, 50, 49],
      [101, 51, 50],
      [12_345, 6_173, 6_172],
      [100_001, 50_001, 50_000],
    ];
    for (const [amount, fee, refund] of cases)
      it(`${amount}¢ splits ${fee}/${refund}`, () => {
        expect(venueCancellationFee(amount, gig, hoursBefore(72))).toEqual({
          feeCents: fee,
          refundCents: refund,
        });
      });

    it("conserves every amount from 0 to 400 cents", () => {
      for (let amount = 0; amount <= 400; amount++) {
        const out = venueCancellationFee(amount, gig, hoursBefore(72));
        expect(out.feeCents + out.refundCents).toBe(amount);
        expect(out.feeCents).toBeGreaterThanOrEqual(0);
        expect(out.refundCents).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("conserves the amount in every window, including zero-value bookings", () => {
    for (const amount of [0, 1, 50_000, 999_999]) {
      for (const hours of [-1, 0, 24, 47, 48, 14 * 24, 15 * 24, 400 * 24]) {
        const out = venueCancellationFee(amount, gig, hoursBefore(hours));
        expect(out.feeCents + out.refundCents).toBe(amount);
      }
    }
  });
});

describe("performer cancellation", () => {
  it("always refunds the venue in full and never charges a fee", () => {
    for (const amount of [0, 1, 99, 12_345, 50_000]) {
      const out = performerCancellationFee(amount);
      expect(out).toEqual({ feeCents: 0, refundCents: amount });
      expect(out.feeCents + out.refundCents).toBe(amount);
    }
  });
});
