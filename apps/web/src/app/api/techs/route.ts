import { newId, techCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { requireUser, respondError, techOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await techOwnedBy(userId))
      return fail("conflict", "you already have a tech profile", 409);
    const parsed = await parseBody(req, techCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("tech");
    const d = db();
    await d.insert(schema.techs).values({
      id,
      ownerUserId: userId,
      ...parsed.data,
      rateLaborCents: parsed.data.rateLaborCents ?? null,
      rateWithRigCents: parsed.data.rateWithRigCents ?? null,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "tech.created",
      subjectType: "tech",
      subjectId: id,
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
