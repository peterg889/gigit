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
    if (!booking) return fail("not_found", "We couldn't find that booking.", 404);
    if (!performer || performer.id !== booking.performerId)
      return fail("forbidden", "That booking isn't yours.", 403);
    const result = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_MARKED_PLAYED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", "That's available once the set is over.", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "Something moved while you were working. Reload and try again.", 409);
    return respondError(e);
  }
}
