import { TERMINAL_STATES, newId, reviewCreateSchema } from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { appendEvent, db, pgErrorCode, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Double-blind reviews (PRD F7.1/F7.2): parties only, terminal bookings only,
 * one per side. Visibility rule (read side): both submitted OR 7 days elapsed.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);
    if (!TERMINAL_STATES.has(booking.state as BookingState))
      return fail("conflict", "booking is not complete yet", 409);

    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    let authorRole: "venue" | "performer";
    if (venue && venue.id === booking.venueId) authorRole = "venue";
    else if (performer && performer.id === booking.performerId)
      authorRole = "performer";
    else return fail("forbidden", "not a party to this booking", 403);

    const parsed = await parseBody(req, reviewCreateSchema);
    if ("response" in parsed) return parsed.response;

    const id = newId("message"); // reviews reuse the ULID generator
    const d = db();
    try {
      await d.insert(schema.reviews).values({
        id,
        bookingId,
        authorRole,
        ratings: parsed.data.ratings,
        body: parsed.data.body,
      });
    } catch (err) {
      // drizzle wraps the pg error, so the constraint name lives on .cause —
      // match the SQLSTATE (23505 = unique_violation) instead of the message.
      if (pgErrorCode(err) === "23505")
        return fail("conflict", "you already reviewed this booking", 409);
      throw err;
    }
    await appendEvent(d, {
      actor: userId,
      kind: "review.submitted",
      subjectType: "booking",
      subjectId: bookingId,
      payload: { authorRole, overall: parsed.data.ratings.overall },
    });
    return ok({ id }, 201);
  } catch (e) {
    return respondError(e);
  }
}
