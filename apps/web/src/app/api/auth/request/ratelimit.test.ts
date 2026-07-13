import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@gigit/db";
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
