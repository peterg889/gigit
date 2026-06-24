import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  SlotUnavailableError,
  db,
  paymentGateway,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { AuthError, performerOwnedBy, requireUser } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/**
 * Performer accepts the offer (click-wrap acceptance recorded by the
 * transition runner). M0's NullPaymentGateway then confirms via the worker.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "performer profile required", 403);

    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);
    if (booking.performerId !== performer.id)
      return fail("forbidden", "not your booking", 403);

    // Payout gate (spec §6): a booking must never confirm with nowhere to
    // send the money. Null gateway (dev) always passes.
    if (!(await paymentGateway().performerPayoutReady(performer.id)))
      return fail(
        "payouts_not_ready",
        "Set up payouts first — it takes a few minutes, and your money needs somewhere to land. Go to Profile → Set up payouts.",
        409,
      );

    const result = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "booking changed concurrently — retry", 409);
    if (e instanceof SlotUnavailableError)
      return fail("slot_unavailable", "Someone else just took this slot.", 409);
    throw e;
  }
}
