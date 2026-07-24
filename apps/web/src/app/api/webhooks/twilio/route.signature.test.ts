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
