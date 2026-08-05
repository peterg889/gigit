import { slotCreateSchema } from "@gigit/domain";
import { createOpenSlot, openSlotFeed } from "@gigit/db";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { venueLocationIsComplete } from "@/lib/date-time";

export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "Create a venue profile first.", 403);
    if (!venueLocationIsComplete(venue))
      return fail(
        "venue_location_required",
        "Add your venue address and time zone before posting an open date.",
        409,
      );
    const parsed = await parseBody(req, slotCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = await createOpenSlot({
      venueId: venue.id,
      actor: userId,
      startsAt: new Date(parsed.data.startsAt),
      durationMinutes: parsed.data.durationMinutes,
      format: parsed.data.format,
      genrePrefs: parsed.data.genrePrefs,
      budgetCents: parsed.data.budgetCents,
      provides: parsed.data.provides,
      notes: parsed.data.notes ?? null,
      source: "web",
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
  // miles, to match every other distance the product states
  const radiusMiles = Number(url.searchParams.get("radius_miles"));
  const rows = await openSlotFeed({
    format,
    metro,
    minBudgetCents: minBudget,
    near: { lat, lng, radiusMiles },
    limit: 100,
  });
  return ok({ slots: rows });
}
