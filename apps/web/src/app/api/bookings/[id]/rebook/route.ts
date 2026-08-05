import {
  InvalidOfferTermsError,
  SlotUnavailableError,
  assertVenueOfferPaymentReady,
  createInvitedOffer,
  db,
  findRebookTarget,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Re-book the same act into the next compatible open night at this venue, at
 * that night's advertised pay (PRD F2.2, anti-leakage). A night in the same
 * series is preferred, while one-off bookings still have a useful repeat path.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "You need a venue profile to do that.", 403);

    const [bk] = await db()
      .select({ venueId: schema.bookings.venueId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!bk) return fail("not_found", "We couldn't find that booking.", 404);
    if (bk.venueId !== venue.id)
      return fail("forbidden", "That booking isn't yours.", 403);

    const target = await findRebookTarget(bookingId);
    if (!target)
      return fail(
        "no_rebook_target",
        "No compatible open upcoming night at this venue is available to re-book.",
        409,
      );

    await assertVenueOfferPaymentReady(venue.id);

    const endsAt = new Date(
      target.startsAt.getTime() + target.durationMinutes * 60_000,
    );
    // Application preparation/revival and the firm offer share one transaction.
    // If this target loses a race after findRebookTarget, no synthetic or
    // spuriously revived application leaks out of the failed re-book.
    const { bookingId: newBookingId } = await createInvitedOffer({
      slotId: target.slotId,
      performerId: target.performerId,
      venueId: target.venueId,
      actor: userId,
      terms: {
        amountCents: target.amountCents,
        startsAt: target.startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        provides: target.provides,
        ...(target.notes ? { notes: target.notes } : {}),
      },
    });
    return ok({ bookingId: newBookingId }, 201);
  } catch (e) {
    if (e instanceof SlotUnavailableError)
      return fail(
        "slot_unavailable",
        "That night is no longer available or already has a firm offer. Reload to see the latest dates.",
        409,
      );
    if (e instanceof InvalidOfferTermsError)
      return fail(
        "rebook_target_changed",
        "That night changed while you were re-booking. Reload and try again.",
        409,
      );
    return respondError(e);
  }
}
