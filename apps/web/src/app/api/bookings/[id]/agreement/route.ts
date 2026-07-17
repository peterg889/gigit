import { renderAgreement } from "@gigit/domain";
import { db, paymentsEnabled, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** The click-wrap agreement text for a booking, rendered from locked terms (K7). */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const [row] = await db()
      .select({
        booking: schema.bookings,
        venueName: schema.venues.name,
        performerName: schema.performers.name,
      })
      .from(schema.bookings)
      .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
      .innerJoin(
        schema.performers,
        eq(schema.bookings.performerId, schema.performers.id),
      )
      .where(eq(schema.bookings.id, id));
    if (!row) return fail("not_found", "booking not found", 404);

    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    const isParty =
      performer?.id === row.booking.performerId || venue?.id === row.booking.venueId;
    if (!isParty) return fail("forbidden", "not a party to this booking", 403);

    return ok({
      templateVersion: row.booking.agreementTemplateVer,
      text: renderAgreement({
        venueName: row.venueName,
        performerName: row.performerName,
        terms: row.booking.terms,
        paymentsEnabled: paymentsEnabled(),
        templateVersion: row.booking.agreementTemplateVer,
      }),
      venueAcceptedAt: row.booking.venueAcceptedAt,
      performerAcceptedAt: row.booking.performerAcceptedAt,
    });
  } catch (e) {
    return respondError(e);
  }
}
