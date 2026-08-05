import { techSubslotCreateSchema } from "@gigit/domain";
import { createTechSubslot } from "@gigit/db";
import { loadBookingForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Either booking party adds a tech sub-slot (PRD F6.2). */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const actor = await loadBookingForActor(bookingId, userId);
    if (!actor) return fail("not_found", "We couldn't find that booking.", 404);
    const { booking } = actor;
    if (!actor.isParty) return fail("forbidden", "That booking isn't yours.", 403);
    if (booking.state !== "confirmed")
      return fail("conflict", "Sound can be added once the booking is confirmed.", 409);

    const parsed = await parseBody(req, techSubslotCreateSchema);
    if ("response" in parsed) return parsed.response;

    const subslotId = await createTechSubslot({
      bookingId,
      payer: parsed.data.payer,
      budgetCents: parsed.data.budgetCents,
      actor: userId,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    });
    return ok({ subslotId }, 201);
  } catch (e) {
    return respondError(e);
  }
}
