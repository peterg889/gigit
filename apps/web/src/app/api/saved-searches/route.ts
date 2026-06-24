import { newId, savedSearchCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

/** Saved-search alerts (PRD F2.3): the worker matches new slots against these. */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "performer profile required", 403);

    const parsed = await parseBody(req, savedSearchCreateSchema);
    if ("response" in parsed) return parsed.response;

    const id = newId("search");
    const d = db();
    await d.insert(schema.savedSearches).values({
      id,
      performerId: performer.id,
      format: parsed.data.format ?? null,
      metro: parsed.data.metro ?? null,
      minBudgetCents: parsed.data.minBudgetCents ?? null,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "saved_search.created",
      subjectType: "saved_search",
      subjectId: id,
      payload: parsed.data,
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}

export async function GET() {
  try {
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "performer profile required", 403);
    const searches = await db()
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.performerId, performer.id));
    return ok({ searches });
  } catch (e) {
    return respondError(e);
  }
}
