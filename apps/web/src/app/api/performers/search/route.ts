import { db, schema } from "@gigit/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

/**
 * Venue-facing performer search (PRD F2.4): kind/genre/metro filters,
 * ranked by reliability (fewest strikes) then tenure. Venue-gated to keep
 * the directory from being scraped; public profiles stay public by id.
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);

    const url = new URL(req.url);
    const kind = url.searchParams.get("kind");
    const genre = url.searchParams.get("genre");
    const metro = url.searchParams.get("metro");

    const conditions = [eq(schema.performers.status, "live")];
    if (kind) conditions.push(eq(schema.performers.kind, kind));
    if (metro) conditions.push(eq(schema.performers.homeMetro, metro));
    if (genre)
      conditions.push(
        sql`${schema.performers.genreTags} @> ${JSON.stringify([genre])}::jsonb`,
      );

    const performers = await db()
      .select({
        id: schema.performers.id,
        name: schema.performers.name,
        kind: schema.performers.kind,
        bio: schema.performers.bio,
        genreTags: schema.performers.genreTags,
        homeMetro: schema.performers.homeMetro,
        rateMinCents: schema.performers.rateMinCents,
        rateMaxCents: schema.performers.rateMaxCents,
        reliabilityStrikes: schema.performers.reliabilityStrikes,
      })
      .from(schema.performers)
      .where(and(...conditions))
      .orderBy(asc(schema.performers.reliabilityStrikes), asc(schema.performers.createdAt))
      .limit(100);
    return ok({ performers });
  } catch (e) {
    return respondError(e);
  }
}
