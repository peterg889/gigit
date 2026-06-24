import { newId, performerCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await performerOwnedBy(userId))
      return fail("conflict", "you already have a performer profile", 409);
    const parsed = await parseBody(req, performerCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("performer");
    const d = db();
    const { techNeeds, ...rest } = parsed.data;
    await d.insert(schema.performers).values({
      id,
      ownerUserId: userId,
      ...rest,
      techNeeds,
      rateMinCents: parsed.data.rateMinCents ?? null,
      rateMaxCents: parsed.data.rateMaxCents ?? null,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "performer.created",
      subjectType: "performer",
      subjectId: id,
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
