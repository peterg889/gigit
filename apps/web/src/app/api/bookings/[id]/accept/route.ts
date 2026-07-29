import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  OfferExpiredError,
  PerformerUnavailableError,
  SlotUnavailableError,
  db,
  paymentGateway,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const acceptSchema = z
  .object({ acceptedTerms: z.literal(true) })
  .strict();

/**
 * Performer accepts the offer after explicitly confirming the deal shown on
 * the booking detail page. M0's NullPaymentGateway then confirms via worker.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "You need an act profile to do that.", 403);

    const [booking] = await db()
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "We couldn't find that booking.", 404);
    if (booking.performerId !== performer.id)
      return fail("forbidden", "That booking isn't yours.", 403);

    const parsed = await parseBody(req, acceptSchema);
    if ("response" in parsed) return parsed.response;

    // Payout gate (spec section 6): a booking must never confirm with nowhere to
    // send the money. Null gateway (dev) always passes.
    if (!(await paymentGateway().performerPayoutReady(performer.id)))
      return fail(
        "payouts_not_ready",
        "Set up payouts first - it takes a few minutes, and your money needs somewhere to land. Go to Profile -> Set up payouts.",
        409,
      );

    const result = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof OfferExpiredError)
      return fail(
        "offer_expired",
        "This offer has expired. Ask the venue to send a new firm offer.",
        409,
      );
    if (e instanceof PerformerUnavailableError)
      return fail(
        "performer_unavailable",
        "You already have another booking at this time. Resolve that calendar conflict before accepting.",
        409,
      );
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "Someone else just updated this booking. Reload and try again.", 409);
    if (e instanceof SlotUnavailableError)
      return fail("slot_unavailable", "This date is no longer available.", 409);
    return respondError(e);
  }
}
