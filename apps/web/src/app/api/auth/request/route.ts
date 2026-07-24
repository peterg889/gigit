import { randomInt } from "node:crypto";
import { authRequestSchema, newId } from "@gigit/domain";
import { appendEvent, db, emailConfigured, env, schema, smsConfigured } from "@gigit/db";
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { clientIp } from "@/lib/client-ip";
import { fail, ok, parseBody } from "@/lib/respond";

const OTP_HOURLY_CAP = 5; // per destination
const OTP_IP_HOURLY_CAP = 20; // per requesting IP (shared NATs get headroom)
const OTP_GLOBAL_HOURLY_CAP = 500; // platform circuit breaker on SMS/email spend

export async function POST(req: Request) {
  const parsed = await parseBody(req, authRequestSchema);
  if ("response" in parsed) return parsed.response;
  const destination = parsed.data.phone ?? parsed.data.email!;
  const ip = clientIp(req);
  const hourAgo = new Date(Date.now() - 3_600_000);
  const countOtps = (where: SQL | undefined) =>
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.authOtps)
      .where(where)
      .then((r) => r[0]?.n ?? 0);

  // Don't accept a sign-in we can't deliver. In production a destination whose
  // channel isn't configured would silently drop the code (the worker can't
  // send it, and prod doesn't echo the dev code), locking the user out with a
  // misleading "sent". Fail fast with a clear, actionable error instead.
  if (env().NODE_ENV === "production") {
    const isEmail = destination.includes("@");
    if (isEmail && !emailConfigured())
      return fail("unavailable", "Email sign-in isn't available right now.", 503);
    if (!isEmail && !smsConfigured())
      return fail("unavailable", "Text-message sign-in isn't available — use email instead.", 503);
  }

  // Layered rate limits on this unauthenticated, SMS/email-spending endpoint:
  // per-destination (per-victim bombing), per-IP (one attacker fanning out
  // across many numbers — the toll-fraud vector), and a global hourly ceiling
  // (circuit breaker on total spend regardless of how the load is distributed).
  const tooBusy = "too many sign-in codes requested — try again later";
  if (
    (await countOtps(
      and(eq(schema.authOtps.destination, destination), gte(schema.authOtps.createdAt, hourAgo)),
    )) >= OTP_HOURLY_CAP
  )
    return fail("rate_limited", tooBusy, 429);
  if (
    ip &&
    (await countOtps(
      and(eq(schema.authOtps.requestIp, ip), gte(schema.authOtps.createdAt, hourAgo)),
    )) >= OTP_IP_HOURLY_CAP
  )
    return fail("rate_limited", tooBusy, 429);
  if ((await countOtps(gte(schema.authOtps.createdAt, hourAgo))) >= OTP_GLOBAL_HOURLY_CAP)
    return fail("rate_limited", tooBusy, 429);

  // Sign-in codes are a credential: they must come from a CSPRNG. Math.random()
  // is a seeded PRNG whose future output can be derived from observed values —
  // and codes are observable to anyone who can request one for their own address.
  const code =
    env().NODE_ENV === "production"
      ? String(randomInt(100000, 1000000))
      : "000000"; // dev/test: fixed code, logged

  const otpId = newId("user"); // otp rows reuse the ULID generator; prefix is irrelevant
  await db().insert(schema.authOtps).values({
    id: otpId,
    destination,
    code,
    requestIp: ip || null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  // The worker delivers the code (Twilio/SES) off this event; it reads the code
  // from the otp row by id, so the code itself never lands in the event log.
  await appendEvent(db(), {
    actor: "system",
    kind: "auth.otp_requested",
    subjectType: "auth",
    subjectId: destination,
    payload: { otpId, effects: [{ kind: "notify", template: "otp", to: "both" }] },
  });

  if (env().NODE_ENV !== "production") {
    console.log(JSON.stringify({ kind: "auth.dev_otp", destination, code }));
  }
  // In production the worker sends the code via Twilio/SES (M1).
  if (!destination) return fail("validation", "destination required", 422);
  return ok({ sent: true });
}
