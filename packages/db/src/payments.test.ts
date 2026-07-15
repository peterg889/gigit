import { describe, expect, it } from "vitest";
import { paymentsEnabled, paymentGateway } from "./payments.js";

/**
 * The reframe rests on "the flag is enough" (docs/pricing.md §4): with no
 * PAYMENTS_ENABLED and no Stripe key — the launch + test default — EightGig
 * processes no gig money. These guard that posture so it can't silently flip.
 */
describe("discovery-first is the default payments posture", () => {
  it("paymentsEnabled() is false without PAYMENTS_ENABLED + a Stripe key", () => {
    expect(paymentsEnabled()).toBe(false);
  });

  it("selects the Null gateway, so charge/transfer/refund are no-ops", () => {
    expect(paymentGateway().name).toBe("null");
  });
});
