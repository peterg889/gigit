import { authVerifySchema, newId } from "@gigit/domain";
import {
  identifierIsBlocked, appendEvent, db, schema } from "@gigit/db";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { createSession } from "@/lib/session";
import { consentVersions } from "@/lib/legal";
import { fail, ok, parseBody } from "@/lib/respond";

/** Wrong guesses allowed per code before it's burned. */
const MAX_OTP_ATTEMPTS = 5;

export async function POST(req: Request) {
  const parsed = await parseBody(req, authVerifySchema);
  if ("response" in parsed) return parsed.response;
  const { phone, email, code, source, campaign } = parsed.data;
  const destination = phone ?? email;
  if (!destination) return fail("validation", "Enter an email address or phone number.", 422);

  const d = db();
  const [otp] = await d
    .select()
    .from(schema.authOtps)
    .where(
      and(
        eq(schema.authOtps.destination, destination),
        isNull(schema.authOtps.consumedAt),
        gt(schema.authOtps.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.authOtps.createdAt))
    .limit(1);

  if (!otp || otp.attempts >= MAX_OTP_ATTEMPTS)
    return fail("otp_invalid", "That code has expired. Ask for a new one.", 401);
  if (otp.code !== code) {
    // `attempts + 1` in SQL, not in JS. Read-modify-write off an unlocked SELECT
    // meant concurrent wrong guesses all read the same value and all wrote the
    // same value — so N parallel guesses cost one attempt, and the cap could be
    // walked around by simply firing them at once.
    await d
      .update(schema.authOtps)
      .set({ attempts: sql`${schema.authOtps.attempts} + 1` })
      .where(eq(schema.authOtps.id, otp.id));
    return fail("otp_invalid", "That code doesn't match. Check it and try again.", 401);
  }
  // Claim the code atomically. The cap and the not-yet-consumed check move into
  // the WHERE so a correct code racing either one loses cleanly: two parallel
  // requests with the right code can't both mint a session, and a guess that
  // arrives alongside the 5th failure can't slip past a stale count.
  const claimed = await d
    .update(schema.authOtps)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.authOtps.id, otp.id),
        isNull(schema.authOtps.consumedAt),
        lt(schema.authOtps.attempts, MAX_OTP_ATTEMPTS),
      ),
    )
    .returning({ id: schema.authOtps.id });
  if (claimed.length === 0)
    return fail("otp_invalid", "That code has expired. Ask for a new one.", 401);

  const byField = phone ? schema.users.phone : schema.users.email;
  let [user] = await d.select().from(schema.users).where(eq(byField, destination));
  // Suspended accounts keep their identifiers, so say it at the door instead
  // of handing out a session that 403s on every route (requireUser gates too).
  if (user?.status === "suspended")
    return fail("suspended", "This account is suspended. Contact support.", 403);
  if (!user) {
    // Deactivation nulls email and phone, so a suspended user who deleted their
    // own account leaves no row to match — and would land here, getting a fresh
    // active account on the same address. The blocklist is the durable half of
    // the suspension.
    if (await identifierIsBlocked(destination, d))
      return fail("suspended", "This account is suspended. Contact support.", 403);
    const id = newId("user");
    [user] = await d
      .insert(schema.users)
      .values({ id, phone: phone ?? null, email: email ?? null })
      .returning();
    await appendEvent(d, {
      actor: id,
      kind: "user.created",
      subjectType: "user",
      subjectId: id,
      payload: {
        ...(source ? { source } : {}),
        ...(campaign ? { campaign } : {}),
      },
    });
  }

  await appendEvent(d, {
    actor: user!.id,
    kind: "user.terms_accepted",
    subjectType: "user",
    subjectId: user!.id,
    payload: consentVersions(),
  });
  await createSession(user!.id);
  return ok({ userId: user!.id });
}
