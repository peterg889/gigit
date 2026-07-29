import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Venue confirms the act played and releases payment now (F4.2) — the
 * counterpart to the performer's mark-played. Without this, the only path to
 * `released` was the 24h auto-confirm timer, so a venue ready to pay had no way
 * to do it. VENUE_CONFIRMED is legal only in `awaiting_confirmation`.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "We couldn't find that booking.", 404);
    if (!venue || venue.id !== booking.venueId)
      return fail("forbidden", "That booking isn't yours.", 403);
    const result = await runBookingTransition(
      bookingId,
      { kind: "VENUE_CONFIRMED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", "You can confirm the night once the set is over.", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "Something moved while you were working. Reload and try again.", 409);
    return respondError(e);
  }
}
