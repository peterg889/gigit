import { IllegalSubslotTransitionError } from "@gigit/domain";
import {
  ConcurrentUpdateError,
  runSubslotTransition,
  SubslotAssigneeChangedError,
} from "@gigit/db";
import { loadSubslotForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Payer cancels (fee schedule protects the tech), tech cancels (full refund),
 * or the proposer takes back a proposal the payer hasn't answered.
 *
 * Withdrawal is here rather than in its own route because it is the same act
 * from the same button: closing this sound job. The authority differs, though,
 * and only the pending state grants it — on a LIVE job the non-payer party has
 * no say in closing something the other side is funding, so `isNonPayerParty`
 * alone would hand the act a cancel button over the venue's booked tech.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();

    const row = await loadSubslotForActor(subslotId, userId);
    if (!row) return fail("not_found", "We couldn't find that sound job.", 404);
    const { isPayer, isBookedTech } = row;
    const isProposer =
      row.subslot.state === "awaiting_payer" && row.isNonPayerParty;
    if (!isPayer && !isBookedTech && !isProposer)
      return fail("forbidden", "That sound gig isn't yours.", 403);

    const result = await runSubslotTransition(
      subslotId,
      isBookedTech
        ? { kind: "TECH_CANCELLED" }
        : isProposer
          ? { kind: "PROPOSAL_WITHDRAWN" }
          : { kind: "PAYER_CANCELLED" },
      userId,
      isBookedTech && row.subslot.techId
        ? { expectedTechId: row.subslot.techId }
        : undefined,
    );
    // The reopen cleanup lives inside runSubslotTransition's transaction now,
    // so it can't be lost between the state change and the delete.
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof SubslotAssigneeChangedError)
      return fail(
        "conflict",
        "Someone else is now booked for this sound job. Reload and try again.",
        409,
      );
    if (e instanceof IllegalSubslotTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "Someone else just updated this sound job. Reload and try again.", 409);
    return respondError(e);
  }
}
