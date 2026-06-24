import { appendEvent, db, supportTriage } from "@gigit/db";
import { z } from "zod";
import { requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

const bodySchema = z.object({ message: z.string().min(5).max(2000) });

/**
 * AI-first support (F9.4): KB-grounded answers reply instantly; everything
 * else escalates to a person (recorded as an event the ops queue can read).
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

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
