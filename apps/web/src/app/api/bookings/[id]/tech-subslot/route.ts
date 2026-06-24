import { techSubslotCreateSchema } from "@gigit/domain";
import { createTechSubslot, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** Either booking party adds a tech sub-slot (PRD F6.2). */
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
    const isParty =
      performer?.id === booking.performerId || venue?.id === booking.venueId;
    if (!isParty) return fail("forbidden", "not your booking", 403);
    if (booking.state !== "confirmed")
      return fail("conflict", `booking is ${booking.state}; sound attaches to confirmed bookings`, 409);

    const parsed = await parseBody(req, techSubslotCreateSchema);
    if ("response" in parsed) return parsed.response;

    const subslotId = await createTechSubslot({
      bookingId,
      payer: parsed.data.payer,
      budgetCents: parsed.data.budgetCents,
      actor: userId,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    });
    return ok({ subslotId }, 201);
  } catch (e) {
    return respondError(e);
  }
}
