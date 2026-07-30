import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const envValues: Record<string, string | undefined> = {
  NODE_ENV: "test",
  TWILIO_AUTH_TOKEN: undefined,
  APP_URL: "http://test",
};
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  env: () => ({ ...(envValues as Record<string, string>) }),
}));

import { POST } from "./route";

const smsRequest = (from = "+15551230000", body = "STOP") =>
  new Request("http://test/api/webhooks/twilio", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, Body: body }).toString(),
  });

/**
 * The inbound-SMS webhook is publicly reachable whether or not Twilio is
 * configured, and its body decides opt-outs and support requests attributed to
 * whatever number the caller claims. With no auth token there is nothing to
 * verify against — so production must refuse rather than trust it. (Deployed
 * AppSecrets ships TWILIO_AUTH_TOKEN empty until SMS is switched on.)
 */
describe("twilio webhook fails closed without a signing token", () => {
  it("refuses unsigned inbound SMS in production", async () => {
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = undefined;
    const res = await POST(smsRequest());
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("not configured");
  });

  it("rejects a bad signature when a token IS configured", async () => {
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = "a-real-twilio-token";
    const res = await POST(smsRequest());
    expect(res.status).toBe(403);
  });

  it("still accepts unsigned requests in dev/test (no token to verify against)", async () => {
    envValues.NODE_ENV = "test";
    envValues.TWILIO_AUTH_TOKEN = undefined;
    const res = await POST(smsRequest());
    expect(res.status).toBe(200);
  });
});

/**
 * A VALID signature was never accepted anywhere in the suite. Every case here
 * and in the Stripe equivalent failed for the same environmental reason — no
 * token configured — so breaking the payload construction (the URL, the
 * parameter sort, the concatenation) would 403 every real inbound message,
 * silently disabling STOP and HELP, with the tests still green.
 */
describe("twilio webhook accepts a correctly signed request", () => {
  const TOKEN = "test-twilio-auth-token";

  /** The signature Twilio itself would compute: HMAC-SHA1 over URL + sorted params. */
  function sign(params: Record<string, string>) {
    const url = "http://test/api/webhooks/twilio";
    const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1));
    const payload = url + sorted.map(([k, v]) => k + v).join("");
    return crypto.createHmac("sha1", TOKEN).update(payload).digest("base64");
  }

  const signedRequest = (params: Record<string, string>, signature?: string) =>
    new Request("http://test/api/webhooks/twilio", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature ?? sign(params),
      },
      body: new URLSearchParams(params).toString(),
    });

  it("honours STOP from a correctly signed request", async () => {
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = TOKEN;
    const res = await POST(signedRequest({ From: "+15551230001", Body: "STOP" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/unsubscribed|stopped|no more/i);
  });

  it("still rejects a wrong signature when a token IS configured", async () => {
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = TOKEN;
    const res = await POST(
      signedRequest({ From: "+15551230002", Body: "STOP" }, "not-the-signature"),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a signature computed over DIFFERENT params (replay/tamper)", async () => {
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = TOKEN;
    // Signed for STOP, sent as HELP — the body is part of the signed payload, so
    // swapping it must not verify.
    const signature = sign({ From: "+15551230003", Body: "STOP" });
    const res = await POST(
      signedRequest({ From: "+15551230003", Body: "HELP" }, signature),
    );
    expect(res.status).toBe(403);
  });

  it("verifies independently of parameter order in the body", async () => {
    // The route sorts params before hashing; if it stopped, a body whose order
    // differs from insertion order would fail. Twilio does not promise an order.
    envValues.NODE_ENV = "production";
    envValues.TWILIO_AUTH_TOKEN = TOKEN;
    const params = { Body: "HELP", From: "+15551230004" }; // Body first
    const res = await POST(signedRequest(params));
    expect(res.status).toBe(200);
  });
});
