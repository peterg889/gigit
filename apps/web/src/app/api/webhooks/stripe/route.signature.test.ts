import { describe, expect, it } from "vitest";
import { POST } from "./route";

/**
 * Signature guards against the REAL constructStripeEvent (no mock): a webhook
 * with no signature, or any signature that fails verification, must be rejected
 * with 400 before it can touch the state machine (engineering-spec K11). With
 * no Stripe keys configured in the test env the verifier throws
 * "stripe is not configured"; with keys set it throws on the garbage signature.
 * Either way the only correct answer is 400 — the event never gets recorded.
 */
const post = (headers: Record<string, string>) =>
  POST(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers,
      body: '{"id":"evt_x","type":"payment_intent.succeeded"}',
    }),
  );

describe("stripe webhook signature guards (audit #21)", () => {
  it("400 when the stripe-signature header is missing", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("400 when the signature fails verification — never reaches the state machine", async () => {
    expect((await post({ "stripe-signature": "t=1,v1=deadbeef" })).status).toBe(400);
  });
});
