import { inquiryCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

const DAILY_INQUIRY_CAP = 10; // engineering-spec §10: anti-spam cap per venue

/** Venue → performer direct inquiry ("message any band"); PRD F5.1. */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    const performer = await performerOwnedBy(userId);

    const parsed = await parseBody(req, inquiryCreateSchema);
    if ("response" in parsed) return parsed.response;

    // Who may open what: venues message performers/techs; performers message
    // techs (to hire sound). Performer→venue cold messaging stays off (F5.1).
    const allowed =
      (venue && (parsed.data.performerId || parsed.data.techId)) ||
      (performer && parsed.data.techId);
    if (!allowed)
      return fail(
        "forbidden",
        "venues can message performers and techs; performers can message techs",
        403,
      );

    // Recipient is a performer or a sound tech (PRD F5.1 / F6 invites).
    const d = db();
    let recipientUserId: string | undefined;
    let recipientRef: Record<string, string> = {};
    if (parsed.data.performerId) {
      const [p] = await d
        .select()
        .from(schema.performers)
        .where(eq(schema.performers.id, parsed.data.performerId));
      if (!p) return fail("not_found", "performer not found", 404);
      recipientUserId = p.ownerUserId;
      recipientRef = { performerId: p.id };
    } else {
      const [t] = await d
        .select()
        .from(schema.techs)
        .where(eq(schema.techs.id, parsed.data.techId!));
      if (!t) return fail("not_found", "tech not found", 404);
      recipientUserId = t.ownerUserId;
      recipientRef = { techId: t.id };
    }

    const since = new Date(Date.now() - 24 * 3_600_000);
    const [{ count }] = (await d
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.threads)
      .innerJoin(
        schema.threadParticipants,
        eq(schema.threads.id, schema.threadParticipants.threadId),
      )
      .where(
        and(
          eq(schema.threads.scope, "inquiry"),
          eq(schema.threadParticipants.userId, userId),
          gte(schema.threads.createdAt, since),
        ),
      )) as [{ count: number }];
    if (count >= DAILY_INQUIRY_CAP)
      return fail("rate_limited", "daily inquiry limit reached", 429);

    const threadId = newId("thread");
    const messageId = newId("message");
    await d.transaction(async (tx) => {
      await tx.insert(schema.threads).values({
        id: threadId,
        scope: "inquiry",
        subjectId: parsed.data.slotId ?? null,
      });
      await tx.insert(schema.threadParticipants).values([
        { threadId, userId },
        { threadId, userId: recipientUserId },
      ]);
      await tx.insert(schema.messages).values({
        id: messageId,
        threadId,
        senderUserId: userId,
        body: parsed.data.body,
      });
      await appendEvent(tx, {
        actor: userId,
        kind: "thread.inquiry_opened",
        subjectType: "thread",
        subjectId: threadId,
        payload: {
          ...recipientRef,
          effects: [{ kind: "notify", template: "new_inquiry", to: "performer" }],
        },
      });
    });
    return ok({ threadId }, 201);
  } catch (e) {
    return respondError(e);
  }
}

export async function GET() {
  try {
    const userId = await requireUser();
    const d = db();
    const mine = d
      .select({ threadId: schema.threadParticipants.threadId })
      .from(schema.threadParticipants)
      .where(eq(schema.threadParticipants.userId, userId));
    const rows = await d
      .select()
      .from(schema.threads)
      .where(inArray(schema.threads.id, mine));
    return ok({ threads: rows });
  } catch (e) {
    return respondError(e);
  }
}
