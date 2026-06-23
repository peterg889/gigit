import { newId } from "@gigit/domain";
import { createOffer, db, findRebookTarget, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, requireUser, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Re-book the same act into the next open night of the slot's series, at the
 * same pay (PRD F2.2, anti-leakage). Venue-only; reuses the offer rails.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);

    const [bk] = await db()
      .select({ venueId: schema.bookings.venueId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!bk) return fail("not_found", "booking not found", 404);
    if (bk.venueId !== venue.id) return fail("forbidden", "not your booking", 403);

    const target = await findRebookTarget(bookingId);
    if (!target)
      return fail(
        "no_rebook_target",
        "No open upcoming night in this series to re-book into.",
        409,
      );

    // Reuse the offer rails: a venue-initiated application, then an offer at the
    // same pay for the next series night. The act accepts like any other offer.
    const applicationId = newId("application");
    await db().insert(schema.applications).values({
      id: applicationId,
      slotId: target.slotId,
      performerId: target.performerId,
      status: "submitted",
    });
    const endsAt = new Date(
      target.startsAt.getTime() + target.durationMinutes * 60_000,
    );
    const newBookingId = await createOffer({
      applicationId,
      slotId: target.slotId,
      performerId: target.performerId,
      venueId: target.venueId,
      actor: userId,
      terms: {
        amountCents: target.amountCents,
        startsAt: target.startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });
    return ok({ bookingId: newBookingId }, 201);
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    throw e;
  }
}
