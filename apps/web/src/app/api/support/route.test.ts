import { describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/support", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify(body),
    }),
  );

describe("public support", () => {
  it("requires a reply address when no account session is available", async () => {
    const res = await post({ message: "I cannot get into my account." });
    expect(res.status).toBe(422);
  });

  it("accepts and escalates a rate-limited locked-out request", async () => {
    const res = await post({
      email: `locked-out-${Date.now()}@example.test`,
      message: "I deactivated my account and need an erasure review.",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ escalated: true });
  });
});
