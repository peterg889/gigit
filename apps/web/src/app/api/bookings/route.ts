import { db, schema } from "@gigit/db";
import { desc, eq, or } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

export async function GET() {
  try {
    const userId = await requireUser();
    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    if (!performer && !venue) return ok({ bookings: [] });

    const conditions = [];
    if (performer) conditions.push(eq(schema.bookings.performerId, performer.id));
    if (venue) conditions.push(eq(schema.bookings.venueId, venue.id));

    const rows = await db()
      .select({
        booking: schema.bookings,
        performerName: schema.performers.name,
        venueName: schema.venues.name,
      })
      .from(schema.bookings)
      .innerJoin(
        schema.performers,
        eq(schema.bookings.performerId, schema.performers.id),
      )
      .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
      .where(or(...conditions))
      .orderBy(desc(schema.bookings.createdAt))
      .limit(100);
    return ok({ bookings: rows });
  } catch (e) {
    return respondError(e);
  }
}
