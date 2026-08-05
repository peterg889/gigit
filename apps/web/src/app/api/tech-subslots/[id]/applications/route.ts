import {
  applyToOpenTechSubslot,
  SubslotNotFoundError,
  TechSubslotApplicationError,
  TechSubslotNotOpenError,
  withdrawTechSubslotApplication,
} from "@gigit/db";
import { requireUser, respondError, techOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Tech one-tap apply — applying to a posted budget is agreeing to it. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();
    const tech = await techOwnedBy(userId);
    if (!tech) return fail("forbidden", "You need a sound tech profile to do that.", 403);

    const note = (await req.json().catch(() => ({})))?.note;
    const id = await applyToOpenTechSubslot({
      subslotId,
      techId: tech.id,
      actor: userId,
      note: typeof note === "string" ? note.slice(0, 1000) : null,
    });
    return ok({ id }, 201);
  } catch (e) {
    if (e instanceof SubslotNotFoundError)
      return fail("not_found", "We couldn't find that sound job.", 404);
    if (e instanceof TechSubslotNotOpenError)
      return fail("conflict", "This sound job is no longer open.", 409);
    if (e instanceof TechSubslotApplicationError && e.reason === "duplicate")
      return fail("conflict", "You've already applied to this sound job.", 409);
    return respondError(e);
  }
}

/** A tech may withdraw while their application is still pending. */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();
    const tech = await techOwnedBy(userId);
    if (!tech) return fail("forbidden", "You need a sound tech profile to do that.", 403);

    await withdrawTechSubslotApplication({
      subslotId,
      techId: tech.id,
      actor: userId,
    });
    return ok({ withdrawn: true });
  } catch (e) {
    if (e instanceof TechSubslotApplicationError) {
      if (e.reason === "not_found")
        return fail("not_found", "We couldn't find that application.", 404);
      if (e.reason === "not_submitted")
        return fail(
          "conflict",
          "This application already has an answer, so there's nothing to withdraw.",
          409,
        );
    }
    return respondError(e);
  }
}
