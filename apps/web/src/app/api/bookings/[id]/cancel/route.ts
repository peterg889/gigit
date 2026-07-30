import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { loadBookingForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Routes to VENUE_CANCELLED or PERFORMER_CANCELLED based on who's calling (PRD F3.3). */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const actor = await loadBookingForActor(bookingId, userId);
    if (!actor) return fail("not_found", "We couldn't find that booking.", 404);
    const { booking } = actor;
    let event:
      | "VENUE_CANCELLED"
      | "PERFORMER_DECLINED"
      | "PERFORMER_CANCELLED";
    if (actor.asVenue) event = "VENUE_CANCELLED";
    else if (actor.asPerformer)
      event =
        booking.state === "offered"
          ? "PERFORMER_DECLINED"
          : "PERFORMER_CANCELLED";
    else return fail("forbidden", "This booking isn't yours.", 403);

    const result = await runBookingTransition(bookingId, { kind: event }, userId);
    return ok({ state: result.to, effects: result.effects });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "Someone else just updated this booking. Reload and try again.", 409);
    return respondError(e);
  }
}
