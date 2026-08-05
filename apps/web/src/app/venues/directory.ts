import { type Db, schema } from "@gigit/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/** Live rooms with an exact count of their still-actionable open dates. */
export async function venueDirectoryRows(d: Db, now = new Date()) {
  const directoryVenues = alias(schema.venues, "directory_venues");
  const directoryOpenSlots = alias(schema.slots, "directory_open_slots");
  return d
    .select({
      venue: directoryVenues,
      openSlots: sql<number>`count(${directoryOpenSlots.id})::int`,
    })
    .from(directoryVenues)
    .leftJoin(
      directoryOpenSlots,
      and(
        eq(directoryOpenSlots.venueId, directoryVenues.id),
        eq(directoryOpenSlots.status, "open"),
        gte(directoryOpenSlots.startsAt, now),
      ),
    )
    .where(eq(directoryVenues.status, "live"))
    .groupBy(directoryVenues.id)
    .orderBy(asc(directoryVenues.name))
    .limit(100);
}
