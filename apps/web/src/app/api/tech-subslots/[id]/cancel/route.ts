import { IllegalSubslotTransitionError } from "@gigit/domain";
import { ConcurrentUpdateError, db, runSubslotTransition, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Payer cancels (fee schedule protects the tech) or tech cancels (full refund). */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { id: subslotId } = await params;
    const userId = await requireUser();

    const d = db();
    const [row] = await d
      .select({ subslot: schema.techSubslots, booking: schema.bookings })
      .from(schema.techSubslots)
      .innerJoin(schema.bookings, eq(schema.techSubslots.bookingId, schema.bookings.id))
      .where(eq(schema.techSubslots.id, subslotId));
    if (!row) return fail("not_found", "sub-slot not found", 404);

    const [performer, venue, tech] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
      techOwnedBy(userId),
    ]);
    const isPayer =
      row.subslot.payer === "venue"
        ? venue?.id === row.booking.venueId
        : performer?.id === row.booking.performerId;
    const isBookedTech = !!tech && tech.id === row.subslot.techId;
    if (!isPayer && !isBookedTech)
      return fail("forbidden", "not your sound booking", 403);

    const result = await runSubslotTransition(
      subslotId,
      isBookedTech ? { kind: "TECH_CANCELLED" } : { kind: "PAYER_CANCELLED" },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalSubslotTransitionError)
      return fail("illegal_transition", e.message, 409);
    if (e instanceof ConcurrentUpdateError)
      return fail("conflict", "sub-slot changed concurrently — retry", 409);
    return respondError(e);
  }
}
