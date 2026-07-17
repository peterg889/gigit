import { createSupportRequest, db, schema, supportTriage } from "@gigit/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { respondError } from "@/lib/auth";
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
    const [sessionUser] = sessionId
      ? await db()
          .select({ status: schema.users.status })
          .from(schema.users)
          .where(eq(schema.users.id, sessionId))
      : [];
    const userId = sessionUser?.status === "active" ? sessionId : null;
    if (!userId) {
      if (!parsed.data.email)
        return fail("validation", "email is required when you are not signed in", 422);

      const d = db();
      const hourAgo = new Date(Date.now() - 3_600_000);
      const ip = clientIp(req) || "unknown";
      // Public submissions carry request_ip (indexed, like auth_otps_ip_idx);
      // counting them here keeps the unbounded events audit log out of the
      // hot path of an unauthenticated endpoint.
      const [counts] = await d
        .select({
          global: sql<number>`count(*)::int`,
          fromIp: sql<number>`count(*) filter (where ${schema.supportRequests.requestIp} = ${ip})::int`,
        })
        .from(schema.supportRequests)
        .where(
          and(
            isNotNull(schema.supportRequests.requestIp),
            gte(schema.supportRequests.createdAt, hourAgo),
          ),
        );
      if (
        (counts?.global ?? 0) >= PUBLIC_GLOBAL_HOURLY_CAP ||
        (counts?.fromIp ?? 0) >= PUBLIC_IP_HOURLY_CAP
      )
        return fail("rate_limited", "too many support requests — try again later", 429);

      const requestId = await createSupportRequest({
        contactEmail: parsed.data.email.toLowerCase(),
        channel: "web",
        category: "other",
        escalationReason: "anonymous",
        message: parsed.data.message,
        requestIp: ip,
      });
      return ok({
        reply: "Thanks — we received your message and will use the email you provided to follow up.",
        escalated: true,
        requestId,
      });
    }

    let result: Awaited<ReturnType<typeof supportTriage>>;
    try {
      result = await supportTriage(parsed.data.message, userId);
    } catch {
      const requestId = await createSupportRequest({
        requesterUserId: userId,
        channel: "web",
        category: "other",
        escalationReason: "triage_error",
        message: parsed.data.message,
      });
      return ok({
        reply: "Got your message — a person will get back to you.",
        escalated: true,
        requestId,
      });
    }
    let requestId: string | undefined;
    if (result.escalate) {
      requestId = await createSupportRequest({
        requesterUserId: userId,
        channel: "web",
        category: result.category,
        escalationReason: "triage",
        message: parsed.data.message,
      });
    }
    return ok({ reply: result.reply, escalated: result.escalate, requestId });
  } catch (e) {
    return respondError(e);
  }
}
