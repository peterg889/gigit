import {
  IllegalSubslotTransitionError,
  techSubslotConsentSchema,
} from "@gigit/domain";
import { ConcurrentUpdateError, runSubslotTransition } from "@gigit/db";
import { loadSubslotForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * The named payer accepts or declines a sound job the OTHER party proposed.
 *
 * This is the whole consent gate at the API edge: `POST
 * /api/bookings/[id]/tech-subslot` checks only that you are a party to the
 * booking, so an act can still name the venue as payer — it just lands in
 * `awaiting_payer` and reaches no tech until the person who would pay says yes
 * here. `isPayer` and nothing else: the other booking party (including the one
 * who proposed it) and every tech get 403, because none of them are the ones
 * being asked to pay.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();

    const row = await loadSubslotForActor(subslotId, userId);
    if (!row) return fail("not_found", "We couldn't find that sound job.", 404);
    if (!row.isPayer)
      return fail(
        "forbidden",
        "Only the side named to pay for sound can accept or decline this job.",
        403,
      );

    const parsed = await parseBody(req, techSubslotConsentSchema);
    if ("response" in parsed) return parsed.response;

    // Whether the job is actually still awaiting an answer is the reducer's
    // call, under the row lock — a second tab that already accepted, or a
    // parent cancellation that closed the proposal, must lose here rather than
    // re-open a job from a terminal state.
    const result = await runSubslotTransition(
      subslotId,
      parsed.data.decision === "accept"
        ? { kind: "PAYER_ACCEPTED" }
        : { kind: "PAYER_DECLINED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalSubslotTransitionError)
      return fail(
        "conflict",
        "This sound job isn't waiting on your answer any more. Reload to see where it stands.",
        409,
      );
    if (e instanceof ConcurrentUpdateError)
      return fail(
        "conflict",
        "Someone else just updated this sound job. Reload and try again.",
        409,
      );
    return respondError(e);
  }
}
