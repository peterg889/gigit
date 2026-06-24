import { messageCreateSchema, newId } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

async function assertParticipant(threadId: string, userId: string) {
  const [row] = await db()
    .select()
    .from(schema.threadParticipants)
    .where(
      and(
        eq(schema.threadParticipants.threadId, threadId),
        eq(schema.threadParticipants.userId, userId),
      ),
    );
  return !!row;
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id: threadId } = await params;
    const userId = await requireUser();
    if (!(await assertParticipant(threadId, userId)))
      return fail("forbidden", "not a participant", 403);
    // Window to the most recent 200 (newest-first from the DB), then reverse to
    // ascending for display. A plain asc+limit returned the OLDEST 200 and hid
    // every later message once a thread crossed 200 — the opposite of a chat view.
    const rows = await db()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(200);
    return ok({ messages: rows.reverse() });
  } catch (e) {
    return respondError(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id: threadId } = await params;
    const userId = await requireUser();
    if (!(await assertParticipant(threadId, userId)))
      return fail("forbidden", "not a participant", 403);
    const parsed = await parseBody(req, messageCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("message");
    const d = db();
    await d.insert(schema.messages).values({
      id,
      threadId,
      senderUserId: userId,
      body: parsed.data.body,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "message.sent",
      subjectType: "thread",
      subjectId: threadId,
      payload: {
        effects: [{ kind: "notify", template: "new_message", to: "both" }],
      },
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
