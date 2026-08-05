import { newId, performerCreateSchema } from "@gigit/domain";
import {
  appendEvent,
  assignFounding,
  db,
  lockActiveAccounts,
  schema,
} from "@gigit/db";
import { performerOwnedBy, requireUser } from "@/lib/auth";
import { respondProfileCreateError } from "@/lib/profile-create";
import { fail, ok, parseBody } from "@/lib/respond";

const PROFILE_EXISTS_MESSAGE =
  "You already have an act profile — edit it from your profile page.";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await performerOwnedBy(userId))
      return fail("conflict", PROFILE_EXISTS_MESSAGE, 409);
    const parsed = await parseBody(req, performerCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("performer");
    const { techNeeds, ...rest } = parsed.data;
    const founding = await db().transaction(async (tx) => {
      await lockActiveAccounts(tx, [userId]);
      const rank = await assignFounding(tx, "performer");
      await tx.insert(schema.performers).values({
        id,
        ownerUserId: userId,
        ...rest,
        techNeeds,
        rateMinCents: parsed.data.rateMinCents ?? null,
        rateMaxCents: parsed.data.rateMaxCents ?? null,
        foundingNumber: rank.foundingNumber,
        foundingMember: rank.foundingMember,
      });
      await appendEvent(tx, {
        actor: userId,
        kind: "performer.created",
        subjectType: "performer",
        subjectId: id,
        payload: { foundingNumber: rank.foundingNumber, foundingMember: rank.foundingMember },
      });
      return rank;
    });
    return ok({ id, ...founding }, 201);
  } catch (e) {
    return respondProfileCreateError(e, PROFILE_EXISTS_MESSAGE);
  }
}
