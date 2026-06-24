import { authRequestSchema, newId } from "@gigit/domain";
import { appendEvent, db, env, schema } from "@gigit/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { fail, ok, parseBody } from "@/lib/respond";

const OTP_HOURLY_CAP = 5;

export async function POST(req: Request) {
  const parsed = await parseBody(req, authRequestSchema);
  if ("response" in parsed) return parsed.response;
  const destination = parsed.data.phone ?? parsed.data.email!;

  // Rate limit per destination (abuse + SMS cost control)
  const [{ recent }] = (await db()
    .select({ recent: sql<number>`count(*)::int` })
    .from(schema.authOtps)
    .where(
      and(
        eq(schema.authOtps.destination, destination),
        gte(schema.authOtps.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    )) as [{ recent: number }];
  if (recent >= OTP_HOURLY_CAP)
    return fail("rate_limited", "too many codes requested — try again later", 429);

  const code =
    env().NODE_ENV === "production"
      ? String(Math.floor(100000 + Math.random() * 900000))
      : "000000"; // dev/test: fixed code, logged

  const otpId = newId("user"); // otp rows reuse the ULID generator; prefix is irrelevant
  await db().insert(schema.authOtps).values({
    id: otpId,
    destination,
    code,
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
