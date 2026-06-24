import { newId, venueCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await venueOwnedBy(userId))
      return fail("conflict", "you already have a venue profile", 409);
    const parsed = await parseBody(req, venueCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("venue");
    const d = db();
    await d.insert(schema.venues).values({
      id,
      ownerUserId: userId,
      ...parsed.data,
      capacity: parsed.data.capacity ?? null,
      noiseCurfew: parsed.data.noiseCurfew ?? null,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "venue.created",
      subjectType: "venue",
      subjectId: id,
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
