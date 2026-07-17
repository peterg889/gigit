import { newId, venueCreateSchema } from "@gigit/domain";
import { appendEvent, db, schema } from "@gigit/db";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    if (await venueOwnedBy(userId))
      return fail("conflict", "you already have a venue profile", 409);
    const parsed = await parseBody(req, venueCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("venue");
    const d = db();
    const { lat, lng, ...profile } = parsed.data;
    const fallback = metroCentroid(parsed.data.metro);
    await d.insert(schema.venues).values({
      id,
      ownerUserId: userId,
      ...profile,
      // Approximate metro coordinates preserve radius-search behavior until
      // address geocoding is added. Owners never have to enter coordinates.
      // Metros without a known centroid store null ("location unknown") —
      // never a fabricated point, which would hide the venue from every
      // radius search.
      lat: lat ?? fallback?.lat ?? null,
      lng: lng ?? fallback?.lng ?? null,
      capacity: parsed.data.capacity ?? null,
      noiseCurfew: parsed.data.noiseCurfew ?? null,
    });
    await appendEvent(d, {
      actor: userId,
      kind: "venue.created",
      subjectType: "venue",
      subjectId: id,
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}

function metroCentroid(metro: string): { lat: number; lng: number } | undefined {
  const known: Record<string, { lat: number; lng: number }> = {
    milwaukee: { lat: 43.0389, lng: -87.9065 },
    chicago: { lat: 41.8781, lng: -87.6298 },
    madison: { lat: 43.0731, lng: -89.4012 },
  };
  return known[metro.trim().toLowerCase()];
}
