import { newId, techCreateSchema } from "@gigit/domain";
import { appendEvent, db, lockActiveAccounts, schema } from "@gigit/db";
import { requireUser, techOwnedBy } from "@/lib/auth";
import { respondProfileCreateError } from "@/lib/profile-create";
import { fail, ok, parseBody } from "@/lib/respond";

const PROFILE_EXISTS_MESSAGE =
  "You already have a sound tech profile — edit it from your profile page.";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await techOwnedBy(userId))
      return fail("conflict", PROFILE_EXISTS_MESSAGE, 409);
    const parsed = await parseBody(req, techCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("tech");
    await db().transaction(async (tx) => {
      await lockActiveAccounts(tx, [userId]);
      await tx.insert(schema.techs).values({
        id,
        ownerUserId: userId,
        ...parsed.data,
        rateLaborCents: parsed.data.rateLaborCents ?? null,
        rateWithRigCents: parsed.data.rateWithRigCents ?? null,
      });
      await appendEvent(tx, {
        actor: userId,
        kind: "tech.created",
        subjectType: "tech",
        subjectId: id,
      });
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondProfileCreateError(e, PROFILE_EXISTS_MESSAGE);
  }
}
