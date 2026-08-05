import { inquiryCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, lockActiveProfileOwners, schema } from "@gigit/db";
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
    let senderVenueId: string | undefined;
    let senderPerformerId: string | undefined;
    if (parsed.data.performerId) senderVenueId = venue?.id;
    else if (parsed.data.techId) {
      // An account can have both profiles. Prefer its live venue identity for
      // tech outreach, then its performer identity; the transaction gate below
      // authoritatively rechecks whichever role was selected.
      if (venue?.status === "live") senderVenueId = venue.id;
      else if (performer) senderPerformerId = performer.id;
      else if (venue) senderVenueId = venue.id;
    }
    if (!senderVenueId && !senderPerformerId)
      return fail(
        "forbidden",
        "venues can message performers and techs; performers can message techs",
        403,
      );

    const threadId = newId("thread");
    const messageId = newId("message");
    return await db().transaction(async (tx) => {
      const active = await lockActiveProfileOwners(tx, {
        performerIds: [
          ...(senderPerformerId ? [senderPerformerId] : []),
          ...(parsed.data.performerId ? [parsed.data.performerId] : []),
        ],
        venueIds: senderVenueId ? [senderVenueId] : [],
        techIds: parsed.data.techId ? [parsed.data.techId] : [],
        additionalUserIds: [userId],
      });
      const recipient = parsed.data.performerId
        ? active.performers.get(parsed.data.performerId)!
        : active.techs.get(parsed.data.techId!)!;
      const recipientRef = parsed.data.performerId
        ? { performerId: parsed.data.performerId }
        : { techId: parsed.data.techId! };
      if (recipient.ownerUserId === userId)
        return fail(
          "self_inquiry",
          "You can't message your own profile.",
          409,
        );

      // Count what this user SENT. Joining through participants counted
      // inquiries other people opened with them too, so a popular act was
      // locked out of sending its own messages despite having sent nothing.
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [{ count }] = (await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.scope, "inquiry"),
            eq(schema.threads.createdByUserId, userId),
            gte(schema.threads.createdAt, since),
          ),
        )) as [{ count: number }];
      if (count >= DAILY_INQUIRY_CAP)
        return fail(
          "rate_limited",
          "You've hit today's message limit. Try again tomorrow.",
          429,
        );

      await tx.insert(schema.threads).values({
        id: threadId,
        scope: "inquiry",
        subjectId: parsed.data.slotId ?? null,
        createdByUserId: userId,
      });
      await tx.insert(schema.threadParticipants).values([
        { threadId, userId },
        { threadId, userId: recipient.ownerUserId },
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
      return ok({ threadId }, 201);
    });
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
