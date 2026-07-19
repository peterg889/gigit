import { authVerifySchema, newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createSession } from "@/lib/session";
import { fail, ok, parseBody } from "@/lib/respond";

export async function POST(req: Request) {
  const parsed = await parseBody(req, authVerifySchema);
  if ("response" in parsed) return parsed.response;
  const { phone, email, code, source, campaign } = parsed.data;
  const destination = phone ?? email;
  if (!destination) return fail("validation", "phone or email required", 422);

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

  if (!otp || otp.attempts >= 5)
    return fail("otp_invalid", "code expired or too many attempts", 401);
  if (otp.code !== code) {
    await d
      .update(schema.authOtps)
      .set({ attempts: otp.attempts + 1 })
      .where(eq(schema.authOtps.id, otp.id));
    return fail("otp_invalid", "incorrect code", 401);
  }
  await d
    .update(schema.authOtps)
    .set({ consumedAt: new Date() })
    .where(eq(schema.authOtps.id, otp.id));

  const byField = phone ? schema.users.phone : schema.users.email;
  let [user] = await d.select().from(schema.users).where(eq(byField, destination));
  // Suspended accounts keep their identifiers, so say it at the door instead
  // of handing out a session that 403s on every route (requireUser gates too).
  if (user?.status === "suspended")
    return fail("suspended", "This account is suspended. Contact support.", 403);
  if (!user) {
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
    payload: { version: "2026-07-13" },
  });
  await createSession(user!.id);
  return ok({ userId: user!.id });
}
