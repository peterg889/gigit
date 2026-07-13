import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  category: z.enum(["no_show", "venue_unavailable", "misrepresentation", "other"]).default("other"),
  reason: z.string().min(5).max(2000),
});

/** Either party opens a dispute during the post-gig window; payout holds (F7.4). */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);

    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    let openedBy: "venue" | "performer";
    if (venue && venue.id === booking.venueId) openedBy = "venue";
    else if (performer && performer.id === booking.performerId) openedBy = "performer";
    else return fail("forbidden", "not a party to this booking", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;

    const result = await runBookingTransition(
      bookingId,
      { kind: "DISPUTE_OPENED", openedBy, reason: "[" + parsed.data.category + "] " + parsed.data.reason },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", "disputes open only in the post-gig window", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "retry", 409);
    return respondError(e);
  }
}
