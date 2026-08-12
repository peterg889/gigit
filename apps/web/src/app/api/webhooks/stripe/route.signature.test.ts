import crypto from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Stripe credentials must exist BEFORE anything imports @gigit/db: env() parses
 * process.env once and caches it, and constructStripeEvent reads that cache.
 *
 * This is the whole point of the file. Previously no keys were set, so
 * constructStripeEvent threw "stripe is not configured" for every case — both
 * tests asserted 400 and got 400 for a reason that had nothing to do with
 * signatures. Deleting the route's verification entirely left them green while
 * anyone on the internet could post events into the booking state machine.
 */
const { WEBHOOK_SECRET } = vi.hoisted(() => {
  const secret = "whsec_test_0123456789abcdef0123456789abcdef";
  process.env.STRIPE_SECRET_KEY = "sk_test_0123456789abcdef0123456789";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  return { WEBHOOK_SECRET: secret };
});

import { POST } from "./route";
import { closeDb } from "@gigit/db";

/** The signature Stripe itself sends: HMAC-SHA256 over `${t}.${payload}`. */
function sign(payload: string, secret = WEBHOOK_SECRET, timestamp?: number) {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${payload}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

const post = (body: string, signature?: string) =>
  POST(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: signature ? { "stripe-signature": signature } : {},
      body,
    }),
  );

/** A payload Stripe would send; the id is unique so replays can't collide. */
const eventPayload = (id = `evt_sig_${Date.now()}_${Math.random().toString(36).slice(2)}`) =>
  JSON.stringify({
    id,
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_test_1", metadata: {} } },
  });

/**
 * Signature guards against the REAL constructStripeEvent (no mock): this route
 * is the only path from Stripe into the booking state machine (engineering-spec
 * K11), so it must accept exactly what Stripe signed and nothing else.
 */
describe("stripe webhook signature guards (audit #21)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("ACCEPTS a correctly signed event — the case that makes the rejections mean something", async () => {
    const payload = eventPayload();
    const res = await post(payload, sign(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("400 when the stripe-signature header is missing", async () => {
    expect((await post(eventPayload())).status).toBe(400);
  });

  it("400 on a garbage signature", async () => {
    expect((await post(eventPayload(), "t=1,v1=deadbeef")).status).toBe(400);
  });

  it("400 when the payload was tampered with after signing", async () => {
    // Signed as a success, delivered as a failure: the body is the signed
    // material, so swapping it must not verify — otherwise an attacker could
    // replay one real captured event to drive any transition they like.
    const signed = eventPayload("evt_sig_tamper");
    const tampered = signed.replace(
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
    );
    const res = await post(tampered, sign(signed));
    expect(res.status).toBe(400);
  });

  it("400 when the signature was computed with the wrong key", async () => {
    const payload = eventPayload();
    const res = await post(payload, sign(payload, "whsec_a_different_secret_entirely"));
    expect(res.status).toBe(400);
  });

  it("400 when the signed timestamp is outside Stripe's replay tolerance", async () => {
    // Correct HMAC, hours old. constructEvent enforces the timestamp window;
    // without it a captured signature stays valid forever.
    const payload = eventPayload();
    const stale = Math.floor(Date.now() / 1000) - 60 * 60 * 6;
    const res = await post(payload, sign(payload, WEBHOOK_SECRET, stale));
    expect(res.status).toBe(400);
  });
});
