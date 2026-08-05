import { IllegalSubslotTransitionError, techSubslotBookSchema } from "@gigit/domain";
import {
  bookTechApplicant,
  ConcurrentUpdateError,
  TechSubslotApplicationError,
} from "@gigit/db";
import { loadSubslotForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** The payer books an applicant tech: TECH_BOOKED → charged + confirmed. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();

    const row = await loadSubslotForActor(subslotId, userId);
    if (!row) return fail("not_found", "We couldn't find that sound job.", 404);
    if (!row.isPayer)
      return fail("forbidden", "Only the side paying for sound can book the tech.", 403);

    const parsed = await parseBody(req, techSubslotBookSchema);
    if ("response" in parsed) return parsed.response;
    const { techId } = parsed.data;

    const result = await bookTechApplicant({
      subslotId,
      techId,
      actor: userId,
    });
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof TechSubslotApplicationError) {
      if (e.reason === "not_found")
        return fail("not_found", "That sound tech hasn't applied to this job.", 404);
      return fail(
        "conflict",
        "That application is no longer pending. Reload the applicant list.",
        409,
      );
    }
    if (e instanceof IllegalSubslotTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "Someone else just updated this sound job. Reload and try again.", 409);
    return respondError(e);
  }
}
