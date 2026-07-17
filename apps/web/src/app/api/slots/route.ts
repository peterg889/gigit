import { newId, slotCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { venueLocationIsComplete } from "@/lib/date-time";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "create a venue profile first", 403);
    if (!venueLocationIsComplete(venue))
      return fail(
        "venue_location_required",
        "add your venue address and timezone before posting a slot",
        409,
      );
    const parsed = await parseBody(req, slotCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("slot");
    const d = db();
    await d.insert(schema.slots).values({
      id,
      venueId: venue.id,
      metro: venue.metro,
      startsAt: new Date(parsed.data.startsAt),
      durationMinutes: parsed.data.durationMinutes,
      format: parsed.data.format,
      genrePrefs: parsed.data.genrePrefs,
      budgetCents: parsed.data.budgetCents,
      provides: parsed.data.provides,
      notes: parsed.data.notes ?? null,
      status: "open",
      source: "web",
    });
    await appendEvent(d, {
      actor: userId,
      kind: "slot.created",
      subjectType: "slot",
      subjectId: id,
      payload: { venueId: venue.id, budgetCents: parsed.data.budgetCents },
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}

/**
 * Open-slot feed (PRD F2.3/F2.7 v1): format, metro, budget floor, and
 * haversine radius on the venue's coordinates. Soonest-first ordering.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const metro = url.searchParams.get("metro");
  const minBudget = Number(url.searchParams.get("min_budget_cents")) || 0;
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radiusKm = Number(url.searchParams.get("radius_km"));
  const conditions = [
    eq(schema.slots.status, "open"),
    gte(schema.slots.startsAt, new Date()),
  ];
  if (format) conditions.push(eq(schema.slots.format, format));
  if (metro) conditions.push(eq(schema.slots.metro, metro));
  if (minBudget > 0) conditions.push(gte(schema.slots.budgetCents, minBudget));
  // Venues without coordinates (metro has no known centroid, no geocoder yet)
  // stay visible under a radius filter — hiding them would blank the venue out
  // of discovery entirely; the metro label lets the performer judge distance.
  if (Number.isFinite(lat) && Number.isFinite(lng) && radiusKm > 0)
    conditions.push(
      sql`(${schema.venues.lat} is null or ${schema.venues.lng} is null
          or 6371 * acos(least(1, cos(radians(${lat})) * cos(radians(${schema.venues.lat}))
          * cos(radians(${schema.venues.lng}) - radians(${lng}))
          + sin(radians(${lat})) * sin(radians(${schema.venues.lat})))) <= ${radiusKm})`,
    );

  const rows = await db()
    .select({
      slot: schema.slots,
      venueName: schema.venues.name,
      venueKind: schema.venues.kind,
      venueAddressLine1: schema.venues.addressLine1,
      venueAddressLine2: schema.venues.addressLine2,
      venueCity: schema.venues.city,
      venueRegion: schema.venues.region,
      venuePostalCode: schema.venues.postalCode,
      venueTimeZone: schema.venues.timeZone,
    })
    .from(schema.slots)
    .innerJoin(schema.venues, eq(schema.slots.venueId, schema.venues.id))
    .where(and(...conditions))
    .orderBy(asc(schema.slots.startsAt))
    .limit(100);
  return ok({ slots: rows });
}
