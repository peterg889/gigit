import { patternFromFirst, seriesCreateSchema } from "@gigit/domain";
import { createSeries, db, seriesForVenue } from "@gigit/db";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";
import { venueLocationIsComplete } from "@/lib/date-time";

/**
 * Recurring slot series (PRD F2.2). The first occurrence anchors the pattern
 * (its weekday + time of day); occurrences materialize as ordinary slots.
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);
    if (!venueLocationIsComplete(venue))
      return fail(
        "venue_location_required",
        "add your venue address and timezone before starting a series",
        409,
      );

    const parsed = await parseBody(req, seriesCreateSchema);
    if ("response" in parsed) return parsed.response;
    const s = parsed.data;

    const seriesId = await createSeries({
      venueId: venue.id,
      metro: venue.metro,
      actor: userId,
      pattern: patternFromFirst(
        new Date(s.startsAt),
        s.durationMinutes,
        s.freq,
        venue.timeZone,
      ),
      defaults: {
        format: s.format,
        genrePrefs: s.genrePrefs,
        budgetCents: s.budgetCents,
        provides: s.provides,
        ...(s.notes !== undefined ? { notes: s.notes } : {}),
      },
    });
    return ok({ seriesId }, 201);
  } catch (e) {
    return respondError(e);
  }
}

/** The signed-in venue's active series. */
export async function GET() {
  try {
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);
    const series = await seriesForVenue(db(), venue.id);
    return ok({ series });
  } catch (e) {
    return respondError(e);
  }
}
