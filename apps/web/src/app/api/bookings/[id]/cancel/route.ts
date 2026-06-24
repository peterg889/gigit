import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Routes to VENUE_CANCELLED or PERFORMER_CANCELLED based on who's calling (PRD F3.3). */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);

    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    let event: "VENUE_CANCELLED" | "PERFORMER_CANCELLED";
    if (venue && venue.id === booking.venueId) event = "VENUE_CANCELLED";
    else if (performer && performer.id === booking.performerId)
      event = "PERFORMER_CANCELLED";
    else return fail("forbidden", "you are not a party to this booking", 403);

    const result = await runBookingTransition(bookingId, { kind: event }, userId);
    return ok({ state: result.to, effects: result.effects });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "booking changed concurrently — retry", 409);
    return respondError(e);
  }
}
