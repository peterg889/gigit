import { db, schema } from "@gigit/db";
import { asc, eq } from "drizzle-orm";
import { ok } from "@/lib/respond";

/**
 * Open tech sub-slot feed (PRD F6.2/F6.3): each carries the gig context a
 * tech needs before saying yes — room, PA, inputs, set times, and the pay.
 */
export async function GET() {
  const rows = await db()
    .select({
      subslot: schema.techSubslots,
      terms: schema.bookings.terms,
      venueName: schema.venues.name,
      venueKind: schema.venues.kind,
      venueAddressLine1: schema.venues.addressLine1,
      venueAddressLine2: schema.venues.addressLine2,
      venueCity: schema.venues.city,
      venueRegion: schema.venues.region,
      venuePostalCode: schema.venues.postalCode,
      venueTimeZone: schema.venues.timeZone,
      paInventory: schema.venues.paInventory,
      performerName: schema.performers.name,
    })
    .from(schema.techSubslots)
    .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.techSubslots.state, "open"))
    .orderBy(asc(schema.techSubslots.createdAt))
    .limit(100);
  return ok({ subslots: rows });
}
