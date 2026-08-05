import { describe, expect, it } from "vitest";
import {
  assertVenueOfferPaymentReady,
  paymentsEnabled,
  paymentGateway,
  VenuePaymentMethodRequiredError,
} from "./payments.js";

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

  it("allows offers through the Null gateway while payments are disabled", async () => {
    await expect(
      assertVenueOfferPaymentReady("venue_discovery_first"),
    ).resolves.toBeUndefined();
  });
});

describe("venue offer payment readiness", () => {
  it("reports a typed failure before an offer is created", async () => {
    const result = assertVenueOfferPaymentReady("venue_missing_payment", {
      venuePaymentReady: async () => false,
    });

    await expect(result).rejects.toMatchObject({
      code: "payment_method_required",
      venueId: "venue_missing_payment",
    });
    await expect(result).rejects.toBeInstanceOf(
      VenuePaymentMethodRequiredError,
    );
  });
});
