import { cancelSeries, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Cancel a series: future unfilled occurrences close; booked nights stand. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);

    const [series] = await db()
      .select()
      .from(schema.slotSeries)
      .where(eq(schema.slotSeries.id, id));
    if (!series) return fail("not_found", "series not found", 404);
    if (series.venueId !== venue.id) return fail("forbidden", "not your series", 403);

    const slotsCancelled = await cancelSeries(id, userId);
    return ok({ slotsCancelled });
  } catch (e) {
    return respondError(e);
  }
}
