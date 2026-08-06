import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq, isNull } from "drizzle-orm";

const createSession = vi.fn(async (_userId: string) => {});
vi.mock("@/lib/session", () => ({ createSession: (id: string) => createSession(id) }));

import { POST } from "./route";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";

const verify = (body: Record<string, unknown>) =>
  POST(
    new Request("http://test/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

// Stands in for auth/request, which stores the destination folded — so this
// must fold too, or every test would be asserting against a row the route can
// never find. (newId() returns an uppercase ULID, so the fixture emails
// genuinely exercise this.)
async function seedOtp(destination: string, code = "123456", opts: Partial<{ attempts: number; expired: boolean }> = {}) {
  await db().insert(schema.authOtps).values({
    id: `otp_${newId("user")}`,
    destination: destination.includes("@")
      ? destination.trim().toLocaleLowerCase("en-US")
      : destination,
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
    const email = `${newId("user").toLowerCase()}@verify.test`;
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

  it("records consent against the versions the pages actually publish", async () => {
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email);
    const res = await verify({ email, code: "123456", termsAccepted: true });
    const { userId } = await res.json();

    // This event is the artifact you'd produce if someone disputed what they
    // agreed to. It was hardcoded to a date the documents had already moved
    // past, so every consent on record pointed at a superseded version.
    const [ev] = await db()
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, userId),
          eq(schema.events.kind, "user.terms_accepted"),
        ),
      );
    expect(ev!.payload).toEqual({
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
  });

  it("counts every concurrent wrong guess, not just one", async () => {
    // `attempts: otp.attempts + 1` in JS off an unlocked SELECT meant twenty
    // parallel guesses all read 0 and all wrote 1 — so firing them at once cost
    // a single attempt and walked around the cap entirely.
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        verify({ email, code: "999999", termsAccepted: true }),
      ),
    );
    const [otp] = await db()
      .select({ attempts: schema.authOtps.attempts })
      .from(schema.authOtps)
      .where(eq(schema.authOtps.destination, email));
    // The exact total is racy — once the cap is reached, later requests bail
    // before incrementing. What must hold is that the guesses did NOT collapse
    // into one, and that the code is burned afterwards.
    expect(otp!.attempts).toBeGreaterThanOrEqual(5);
    const afterwards = await verify({ email, code: "123456", termsAccepted: true });
    expect(afterwards.status).toBe(401);
  });

  it("only one of two concurrent correct submissions can claim the code", async () => {
    // Consuming was a blind UPDATE, so both requests saw an unconsumed row and
    // both minted a session off one code.
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email);
    const results = await Promise.all([
      verify({ email, code: "123456", termsAccepted: true }),
      verify({ email, code: "123456", termsAccepted: true }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("refuses a request that names two different destinations", async () => {
    // The code was checked against the phone and the user row was then created
    // carrying the email — an account minted around someone else's address.
    const mine = "+15555550123";
    const theirs = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(mine);
    const res = await verify({
      phone: mine,
      email: theirs,
      code: "123456",
      termsAccepted: true,
    });
    expect(res.status).toBe(422);
    const rows = await db()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, theirs));
    expect(rows).toHaveLength(0);
  });

  it("treats an address as the same account whatever the capitalisation", async () => {
    // auth/request stored the OTP under the address AS TYPED and auth/verify
    // looked the user up with an exact match, so Foo@x.com and foo@x.com were
    // two accounts. Signing in with the "wrong" capitalisation silently minted a
    // second one — and for the admin account that is a 403 on /admin with
    // nothing to explain it.
    const lower = `case-${newId("user").toLowerCase()}@verify.test`;
    const upper = lower.toUpperCase();

    await seedOtp(lower);
    const first = await verify({ email: lower, code: "123456", termsAccepted: true });
    expect(first.status).toBe(200);
    const { userId } = await first.json();

    // Same human, shouting. Must land on the SAME account, not a new one.
    await seedOtp(lower);
    const second = await verify({ email: upper, code: "123456", termsAccepted: true });
    expect(second.status).toBe(200);
    expect((await second.json()).userId).toBe(userId);

    const rows = await db()
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, lower));
    expect(rows).toHaveLength(1);
    // stored folded, so a direct lookup by the typed form still finds it
    expect(rows[0]!.email).toBe(lower);
  });

  it("finds the OTP even when the code was requested in another case", async () => {
    // request and verify have to agree on the destination or the code appears
    // to have expired the moment it is typed with different capitalisation.
    const lower = `otpcase-${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(lower);
    const res = await verify({
      email: lower.replace("otpcase", "OtpCase"),
      code: "123456",
      termsAccepted: true,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const email = `${newId("user").toLowerCase()}@verify.test`;
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
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email, "123456", { attempts: 5 });
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(401);
  });

  it("rejects an expired code", async () => {
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email, "123456", { expired: true });
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(401);
  });

  it("requires terms acceptance", async () => {
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await seedOtp(email);
    const res = await verify({ email, code: "123456" });
    expect(res.status).toBe(422);
  });

  it("refuses a suspended account at the door", async () => {
    const email = `${newId("user").toLowerCase()}@verify.test`;
    await db()
      .insert(schema.users)
      .values({ id: newId("user"), email, status: "suspended" });
    await seedOtp(email);
    const res = await verify({ email, code: "123456", termsAccepted: true });
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });
});
