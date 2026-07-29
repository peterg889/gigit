import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import * as schema from "./schema.js";

/**
 * The open-slot feed, in one place.
 *
 * This query was written twice — once in the slots page, once in GET /api/slots —
 * and the copies had already drifted on two predicates: the API compared format
 * for equality (so it hid every `either` night the page showed, the exact
 * wildcard bug fixed once already in saved-search matching) and it matched metro
 * raw against a column the schema always lowercases (so `?metro=Milwaukee`
 * returned nothing). Both surfaces now share this.
 */
export interface OpenSlotFilters {
  /** `music` | `comedy` | `either` | null. `either` is a wildcard both ways. */
  format?: string | null;
  metro?: string | null;
  minBudgetCents?: number;
  near?: { lat: number; lng: number; radiusMiles: number } | null;
  limit?: number;
}

const MILES_PER_RADIAN = 3958.8;

export function openSlotConditions(filters: OpenSlotFilters) {
  const conditions = [
    eq(schema.slots.status, "open"),
    gte(schema.slots.startsAt, new Date()),
    // A hidden venue (deactivated or suspended owner) must not keep collecting
    // applications through its still-listed open nights.
    eq(schema.venues.status, "live"),
  ];
  // `either` is a wildcard on BOTH sides: an `either` night fits any preference,
  // and asking for `either` means "don't care".
  const format = filters.format?.trim();
  if (format && format !== "either")
    conditions.push(inArray(schema.slots.format, [format, "either"]));
  // metroSchema lowercases and trims on the way in, so a filter has to match.
  const metro = filters.metro?.trim().toLocaleLowerCase();
  if (metro) conditions.push(eq(schema.slots.metro, metro));
  if (filters.minBudgetCents && filters.minBudgetCents > 0)
    conditions.push(gte(schema.slots.budgetCents, filters.minBudgetCents));
  const near = filters.near;
  // Venues without coordinates (metro has no known centroid, no geocoder yet)
  // stay visible under a radius filter — hiding them would blank the venue out
  // of discovery entirely; the metro label lets the performer judge distance.
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng) && near.radiusMiles > 0)
    conditions.push(
      sql`(${schema.venues.lat} is null or ${schema.venues.lng} is null
          or ${MILES_PER_RADIAN} * acos(least(1, cos(radians(${near.lat})) * cos(radians(${schema.venues.lat}))
          * cos(radians(${schema.venues.lng}) - radians(${near.lng}))
          + sin(radians(${near.lat})) * sin(radians(${schema.venues.lat})))) <= ${near.radiusMiles})`,
    );
  return conditions;
}

/** The projection both the feed page and the feed API render. */
export const openSlotColumns = {
  slot: schema.slots,
  venueName: schema.venues.name,
  venueKind: schema.venues.kind,
  venueAddressLine1: schema.venues.addressLine1,
  venueAddressLine2: schema.venues.addressLine2,
  venueCity: schema.venues.city,
  venueRegion: schema.venues.region,
  venuePostalCode: schema.venues.postalCode,
  venueTimeZone: schema.venues.timeZone,
} as const;

export async function openSlotFeed(filters: OpenSlotFilters = {}) {
  return db()
    .select(openSlotColumns)
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .where(and(...openSlotConditions(filters)))
    .orderBy(asc(schema.slots.startsAt))
    .limit(filters.limit ?? 50);
}
