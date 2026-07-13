import { renderAgreement } from "@gigit/domain";
import { db, paymentsEnabled, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";
import { formatAddress } from "@/lib/date-time";

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
        venueTimeZone: schema.venues.timeZone,
        venueAddressLine1: schema.venues.addressLine1,
        venueAddressLine2: schema.venues.addressLine2,
        venueCity: schema.venues.city,
        venueRegion: schema.venues.region,
        venuePostalCode: schema.venues.postalCode,
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
        venueAddress: formatAddress({
          addressLine1: row.venueAddressLine1,
          addressLine2: row.venueAddressLine2,
          city: row.venueCity,
          region: row.venueRegion,
          postalCode: row.venuePostalCode,
        }),
        performerName: row.performerName,
        terms: row.booking.terms,
        timeZone: row.venueTimeZone,
        paymentsEnabled: paymentsEnabled(),
      }),
      venueAcceptedAt: row.booking.venueAcceptedAt,
      performerAcceptedAt: row.booking.performerAcceptedAt,
    });
  } catch (e) {
    return respondError(e);
  }
}
