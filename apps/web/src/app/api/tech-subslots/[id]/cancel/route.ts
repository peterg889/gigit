import { IllegalSubslotTransitionError } from "@gigit/domain";
import { ConcurrentUpdateError, db, runSubslotTransition, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { loadSubslotForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Payer cancels (fee schedule protects the tech) or tech cancels (full refund). */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();

    const d = db();
    const row = await loadSubslotForActor(subslotId, userId);
    if (!row) return fail("not_found", "We couldn't find that sound job.", 404);
    const { isPayer, isBookedTech } = row;
    if (!isPayer && !isBookedTech)
      return fail("forbidden", "That sound gig isn't yours.", 403);

    const result = await runSubslotTransition(
      subslotId,
      isBookedTech ? { kind: "TECH_CANCELLED" } : { kind: "PAYER_CANCELLED" },
      userId,
    );
    // The reopen cleanup lives inside runSubslotTransition's transaction now,
    // so it can't be lost between the state change and the delete.
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalSubslotTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "Someone else just updated this sound job. Reload and try again.", 409);
    return respondError(e);
  }
}
