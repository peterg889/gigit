import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * The OTP route must not accept a sign-in it can't deliver: in production a
 * destination whose channel isn't configured would silently drop the code and
 * return a misleading success (audit). With no Twilio/SES env in test, both
 * channels are "unconfigured", so a production request is refused with 503.
 */
describe("auth/request channel gate (production)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("503 for a phone destination when SMS isn't configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ phone: "+15551234567" });
    expect(res.status).toBe(503);
  });

  it("503 for an email destination when SES isn't configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ email: "nobody@gate.test" });
    expect(res.status).toBe(503);
  });
});
