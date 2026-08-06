import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@gigit/db";
import { notLike } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { POST } from "./route";

const runId = randomUUID();

const post = (body: unknown, ip?: string) =>
  POST(
    new Request("http://test/api/auth/request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

/**
 * /api/auth/request is unauthenticated and spends real SMS/email per call.
 * Beyond the per-destination cap it now also caps per requesting IP (the
 * toll-fraud fan-out vector) and globally (audit). Runs in test mode, so the
 * production channel gate is inactive and codes insert normally.
 */
describe("auth/request rate limits", () => {
  /**
   * The per-destination and per-IP keys are already unique per run, but the
   * third cap is a PLATFORM-wide hourly ceiling — so every OTP any other test
   * minted counts against it, and on a long-lived dev database the rows pile up
   * across runs until the first `expect(200)` here gets a 429 and the failure
   * points at rate limiting rather than at the real cause.
   *
   * Test files run sequentially and none needs another's codes, so clearing
   * everything that isn't ours makes the global counter mean what this file
   * assumes it means.
   */
  beforeAll(async () => {
    await db()
      .delete(schema.authOtps)
      .where(notLike(schema.authOtps.destination, `%${runId}%`));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("caps at 5 codes per destination", async () => {
    const email = `ratelimit-dest-${runId}@x.test`;
    for (let i = 0; i < 5; i++) expect((await post({ email })).status).toBe(200);
    expect((await post({ email })).status).toBe(429);
  });

  it("caps per requesting IP across many destinations (fan-out / toll fraud)", async () => {
    const suffix = runId.replaceAll("-", "");
    const ip = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`;
    for (let i = 0; i < 20; i++)
      expect((await post({ email: `ipcap-${runId}-${i}@x.test` }, ip)).status).toBe(200);
    expect((await post({ email: `ipcap-${runId}-over@x.test` }, ip)).status).toBe(429);
  });
});
