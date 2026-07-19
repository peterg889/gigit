import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq, isNull } from "drizzle-orm";

const createSession = vi.fn(async (_userId: string) => {});
vi.mock("@/lib/session", () => ({ createSession: (id: string) => createSession(id) }));

import { POST } from "./route";

const verify = (body: Record<string, unknown>) =>
  POST(
    new Request("http://test/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function seedOtp(destination: string, code = "123456", opts: Partial<{ attempts: number; expired: boolean }> = {}) {
  await db().insert(schema.authOtps).values({
    id: newId("otp"),
    destination,
    code,
    attempts: opts.attempts ?? 0,
    expiresAt: new Date(Date.now() + (opts.expired ? -1 : 1) * 600_000),
  });
}

/**
 * The sign-in gate had no direct test: code matching, attempt caps, expiry,
 * signup-on-first-verify, and the suspended-account door check.
 */
describe("auth verify route", () => {
  beforeEach(() => createSession.mockClear());
  afterAll(async () => {
    await closeDb();
  });

  it("signs up a brand-new email on first verify and creates a session", async () => {
    const email = `${newId("user")}@verify.test`;
    await seedOtp(email);
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(200);
    const { userId } = await res.json();
    expect(createSession).toHaveBeenCalledWith(userId);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u?.email).toBe(email);
    // OTP is consumed: replaying the same code fails
    const replay = await verify({ email, code: "123456", termsAccepted: true });
    expect(replay.status).toBe(401);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const email = `${newId("user")}@verify.test`;
    await seedOtp(email);
    const res = await verify({ email, code: "654321", termsAccepted: true });
    expect(res.status).toBe(401);
    const [otp] = await db()
      .select()
      .from(schema.authOtps)
      .where(and(eq(schema.authOtps.destination, email), isNull(schema.authOtps.consumedAt)));
    expect(otp?.attempts).toBe(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("locks out after 5 failed attempts even with the right code", async () => {
    const email = `${newId("user")}@verify.test`;
    await seedOtp(email, "123456", { attempts: 5 });
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(401);
  });

  it("rejects an expired code", async () => {
    const email = `${newId("user")}@verify.test`;
    await seedOtp(email, "123456", { expired: true });
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(401);
  });

  it("requires terms acceptance", async () => {
    const email = `${newId("user")}@verify.test`;
    await seedOtp(email);
    const res = await verify({ email, code: "123456" });
    expect(res.status).toBe(422);
  });

  it("refuses a suspended account at the door", async () => {
    const email = `${newId("user")}@verify.test`;
    await db()
      .insert(schema.users)
      .values({ id: newId("user"), email, status: "suspended" });
    await seedOtp(email);
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });
});
