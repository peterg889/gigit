import { db, schema } from "@gigit/db";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, gt } from "drizzle-orm";
import { ok } from "@/lib/respond";

/**
 * Open tech sub-slot feed (PRD F6.2/F6.3): each carries the gig context a
 * tech needs before saying yes — room, PA, inputs, set times, and the pay.
 *
 * The eligibility predicate below is NOT optional and must not drift from
 * apps/web/src/app/techs/page.tsx, which renders the same feed. This route
 * previously filtered on `state = 'open'` ALONE, while the page filtered on six
 * conditions — so it served sound jobs for cancelled bookings and gigs that had
 * already happened, and it named venues and acts whose accounts were hidden,
 * suspended or deleted. Suspension is the only moderation lever this product
 * has; an unauthenticated endpoint that keeps publishing a suspended venue's
 * name and street address defeats it. The page's own test
 * ("lists only future open sound work attached to a confirmed, active gig")
 * asserted these exclusions all along; nothing asserted them here.
 */
export async function GET() {
  const venueOwners = alias(schema.users, "subslot_feed_venue_owners");
  const performerOwners = alias(schema.users, "subslot_feed_performer_owners");
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
    .innerJoin(schema.slots, eq(schema.bookings.slotId, schema.slots.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .innerJoin(venueOwners, eq(schema.venues.ownerUserId, venueOwners.id))
    .innerJoin(performerOwners, eq(schema.performers.ownerUserId, performerOwners.id))
    .where(
      and(
        eq(schema.techSubslots.state, "open"),
        eq(schema.bookings.state, "confirmed"),
        gt(schema.slots.startsAt, new Date()),
        eq(schema.venues.status, "live"),
        eq(schema.performers.status, "live"),
        eq(venueOwners.status, "active"),
        eq(performerOwners.status, "active"),
      ),
    )
    // Same ordering as the page: soonest downbeat first, creation time as a
    // stable tie-breaker, so urgent work cannot be crowded out.
    .orderBy(asc(schema.slots.startsAt), asc(schema.techSubslots.createdAt))
    .limit(100);
  return ok({ subslots: rows });
}
