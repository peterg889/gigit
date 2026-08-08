import {
  isReviewableBookingState,
  newId,
  reviewCreateSchema,
} from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { appendEvent, db, pgErrorCode, schema } from "@gigit/db";
import { loadBookingForActor, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Double-blind reviews (PRD F7.1/F7.2): parties only, completed gigs only, one
 * per side. Visibility rule (read side): both submitted OR 7 days elapsed.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const actor = await loadBookingForActor(bookingId, userId);
    if (!actor) return fail("not_found", "We couldn't find that booking.", 404);
    // State before role: an outsider poking at a live booking learns only that
    // reviews aren't open yet, which is public from the gig date anyway.
    if (!isReviewableBookingState(actor.booking.state as BookingState))
      return fail("conflict", "Reviews open once the gig is done.", 409);

    // Venue first: an owner who is both parties to their own booking has always
    // authored as the venue, and the double-blind pairing is keyed on the role.
    let authorRole: "venue" | "performer";
    if (actor.asVenue) authorRole = "venue";
    else if (actor.asPerformer) authorRole = "performer";
    else return fail("forbidden", "This booking isn't yours.", 403);

    const parsed = await parseBody(req, reviewCreateSchema);
    if ("response" in parsed) return parsed.response;

    const id = newId("message"); // reviews reuse the ULID generator
    const d = db();
    try {
      await d.transaction(async (tx) => {
        await tx.insert(schema.reviews).values({
          id,
          bookingId,
          authorRole,
          ratings: parsed.data.ratings,
          body: parsed.data.body,
        });
        await appendEvent(tx, {
          actor: userId,
          kind: "review.submitted",
          subjectType: "booking",
          subjectId: bookingId,
          payload: { authorRole, overall: parsed.data.ratings.overall },
        });
      });
    } catch (err) {
      // drizzle wraps the pg error, so the constraint name lives on .cause —
      // match the SQLSTATE (23505 = unique_violation) instead of the message.
      if (pgErrorCode(err) === "23505")
        return fail("conflict", "You've already reviewed this gig.", 409);
      throw err;
    }
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
