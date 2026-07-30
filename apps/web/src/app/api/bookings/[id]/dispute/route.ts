import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadBookingForActor, requireUser, respondError } from "@/lib/auth";
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
    const actor = await loadBookingForActor(bookingId, userId);
    if (!actor) return fail("not_found", "We couldn't find that booking.", 404);
    const { booking } = actor;
    let openedBy: "venue" | "performer";
    if (actor.asVenue) openedBy = "venue";
    else if (actor.asPerformer) openedBy = "performer";
    else return fail("forbidden", "This booking isn't yours.", 403);

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
      return fail("illegal_transition", "Disputes open after the gig and close a few days later.", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "Something moved while you were working. Reload and try again.", 409);
    return respondError(e);
  }
}
