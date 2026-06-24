import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Performer records "we played" (F4.2); release still waits for venue confirm or +24h. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);
    if (!performer || performer.id !== booking.performerId)
      return fail("forbidden", "not your booking", 403);
    const result = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_MARKED_PLAYED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", "only after the gig ends", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "retry", 409);
    return respondError(e);
  }
}
