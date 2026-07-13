import { offerCreateSchema } from "@gigit/domain";
import {
  InvalidOfferTermsError,
  SlotUnavailableError,
  createOffer,
  db,
  paymentGateway,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Venue makes a locked-terms offer to an applicant (PRD F3.1). */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: applicationId } = await params;
    const userId = await requireUser();
    const venue = await venueOwnedBy(userId);
    if (!venue) return fail("forbidden", "venue profile required", 403);

    const d = db();
    const [row] = await d
      .select({ application: schema.applications, slot: schema.slots })
      .from(schema.applications)
      .innerJoin(schema.slots, eq(schema.applications.slotId, schema.slots.id))
      .where(eq(schema.applications.id, applicationId));
    if (!row) return fail("not_found", "application not found", 404);
    if (row.slot.venueId !== venue.id)
      return fail("forbidden", "not your slot", 403);
    if (row.application.status !== "submitted")
      return fail("conflict", `application is ${row.application.status}`, 409);
    if (row.slot.status !== "open") return fail("conflict", "slot is not open", 409);

    // Charge gate (F4.1): the card that gets charged at confirmation must
    // exist before the offer goes out. Null gateway (dev) always passes.
    if (!(await paymentGateway().venuePaymentReady(venue.id)))
      return fail(
        "payment_method_required",
        "Add a payment method first — the booking is charged when the act accepts. Go to Profile → Add a payment method.",
        409,
      );

    const parsed = await parseBody(req, offerCreateSchema);
    if ("response" in parsed) return parsed.response;
    if (parsed.data.amountCents !== row.slot.budgetCents)
      return fail(
        "offer_amount_mismatch",
        `Offer must match the advertised $${(row.slot.budgetCents / 100).toFixed(2)}. Edit the slot before making an offer.`,
        400,
      );

    const startsAt = row.slot.startsAt;
    const endsAt = new Date(startsAt.getTime() + row.slot.durationMinutes * 60_000);
    const lockedNotes = [row.slot.notes, parsed.data.notes]
      .filter((note): note is string => Boolean(note?.trim()))
      .join("\n\n");
    const bookingId = await createOffer({
      applicationId,
      slotId: row.slot.id,
      performerId: row.application.performerId,
      venueId: venue.id,
      actor: userId,
      terms: {
        amountCents: row.slot.budgetCents,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        provides: row.slot.provides,
        ...(parsed.data.setLengthMinutes !== undefined
          ? { setLengthMinutes: parsed.data.setLengthMinutes }
          : {}),
        ...(lockedNotes ? { notes: lockedNotes } : {}),
      },
    });
    return ok({ bookingId }, 201);
  } catch (e) {
    if (e instanceof SlotUnavailableError)
      return fail(
        "slot_unavailable",
        "This slot already has a firm offer. Withdraw it or wait for it to expire before offering another act.",
        409,
      );
    if (e instanceof InvalidOfferTermsError)
      return fail("invalid_offer", e.message, 409);
    return respondError(e);
  }
}
