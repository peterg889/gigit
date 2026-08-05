import { newId, reviewCreateSchema } from "@gigit/domain";
import { appendEvent, db, pgErrorCode, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { loadSubslotForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();
    const d = db();
    const actor = await loadSubslotForActor(subslotId, userId);
    if (!actor) return fail("not_found", "We couldn't find that sound gig.", 404);
    if (actor.subslot.state !== "released")
      return fail("conflict", "Reviews open once the sound gig is done.", 409);

    let authorRole: "payer" | "tech";
    if (actor.isBookedTech) authorRole = "tech";
    else {
      if (!actor.isPayer) return fail("forbidden", "This sound gig isn't yours.", 403);
      authorRole = "payer";
    }

    const parsed = await parseBody(req, reviewCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("message");
    try {
      await d.transaction(async (tx) => {
        await tx.insert(schema.techSubslotReviews).values({
          id,
          subslotId,
          authorRole,
          ratings: parsed.data.ratings,
          body: parsed.data.body,
        });
        await appendEvent(tx, {
          actor: userId,
          kind: "subslot.review_submitted",
          subjectType: "tech_subslot",
          subjectId: subslotId,
          payload: { authorRole, overall: parsed.data.ratings.overall },
        });
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        return fail("conflict", "You've already reviewed this sound gig.", 409);
      throw error;
    }
    return ok({ id }, 201);
  } catch (error) {
    return respondError(error);
  }
}
