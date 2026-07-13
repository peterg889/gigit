import { appendEvent, db, schema, supportTriage } from "@gigit/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, respondError } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { fail, ok, parseBody } from "@/lib/respond";
import { sessionUserId } from "@/lib/session";

const bodySchema = z.object({
  message: z.string().min(5).max(2000),
  email: z.string().email().optional(),
});

const PUBLIC_IP_HOURLY_CAP = 5;
const PUBLIC_GLOBAL_HOURLY_CAP = 100;

/**
 * AI-first support (F9.4): KB-grounded answers reply instantly; everything
 * else escalates to a person (recorded as an event the ops queue can read).
 * Locked-out and deactivated people can still leave a reply address; those
 * public submissions are always escalated and tightly rate-limited.
 */
export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const sessionId = await sessionUserId();
    if (!sessionId) {
      if (!parsed.data.email)
        return fail("validation", "email is required when you are not signed in", 422);

      const d = db();
      const hourAgo = new Date(Date.now() - 3_600_000);
      const ip = clientIp(req) || "unknown";
      const base = and(
        eq(schema.events.kind, "support.escalated"),
        eq(schema.events.subjectType, "support"),
        gte(schema.events.occurredAt, hourAgo),
      );
      const [globalCount, ipCount] = await Promise.all([
        d
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.events)
          .where(base)
          .then((rows) => rows[0]?.n ?? 0),
        d
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.events)
          .where(and(base, sql`${schema.events.payload}->>'requestIp' = ${ip}`))
          .then((rows) => rows[0]?.n ?? 0),
      ]);
      if (globalCount >= PUBLIC_GLOBAL_HOURLY_CAP || ipCount >= PUBLIC_IP_HOURLY_CAP)
        return fail("rate_limited", "too many support requests — try again later", 429);

      await appendEvent(d, {
        actor: "anonymous",
        kind: "support.escalated",
        subjectType: "support",
        subjectId: `public:${crypto.randomUUID()}`,
        payload: {
          message: parsed.data.message.slice(0, 500),
          email: parsed.data.email,
          requestIp: ip,
          category: "public",
        },
      });
      return ok({
        reply: "Thanks — we received your message and will use the email you provided to follow up.",
        escalated: true,
      });
    }

    const userId = await requireUser();
    const result = await supportTriage(parsed.data.message, userId);
    if (result.escalate) {
      await appendEvent(db(), {
        actor: userId,
        kind: "support.escalated",
        subjectType: "user",
        subjectId: userId,
        payload: { message: parsed.data.message.slice(0, 500), category: result.category },
      });
    }
    return ok({ reply: result.reply, escalated: result.escalate });
  } catch (e) {
    return respondError(e);
  }
}
