import { newId } from "@gigit/domain";
import {
  SlotUnavailableError,
  createOffer,
  db,
  findRebookTarget,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Re-book the same act into the next open night of the slot's series at that
 * night's advertised pay (PRD F2.2, anti-leakage). Venue-only; reuses offers.
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
        "No open upcoming night in this series to re-book into.",
        409,
      );

    // Reuse the offer rails: a venue-initiated application, then a firm offer
    // matching the target slot. The act reviews and accepts like any offer.
    const applicationId = newId("application");
    try {
      await db().insert(schema.applications).values({
        id: applicationId,
        slotId: target.slotId,
        performerId: target.performerId,
        status: "submitted",
      });
    } catch (err) {
      // findRebookTarget checks for an existing application, so a concurrent
      // apply between that check and this insert trips the unique index. That
      // surfaced as an unhandled 500; it's a lost race, which is a 409.
      if ((err as { code?: string })?.code === "23505")
        return fail(
          "conflict",
          "That act just applied to this date on their own. Reload to see it.",
          409,
        );
      throw err;
    }
    const endsAt = new Date(
      target.startsAt.getTime() + target.durationMinutes * 60_000,
    );
    let newBookingId: string;
    try {
      newBookingId = await createOffer({
        applicationId,
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
    } catch (e) {
      // The application is an internal rebooking seam and has not been exposed
      // to the performer yet, so remove it if the firm offer loses a race.
      await db()
        .delete(schema.applications)
        .where(eq(schema.applications.id, applicationId));
      throw e;
    }
    return ok({ bookingId: newBookingId }, 201);
  } catch (e) {
    if (e instanceof SlotUnavailableError)
      return fail(
        "slot_unavailable",
        "That night already has a firm offer.",
        409,
      );
    return respondError(e);
  }
}
