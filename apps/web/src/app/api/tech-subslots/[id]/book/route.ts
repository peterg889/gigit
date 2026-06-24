import { IllegalSubslotTransitionError, techSubslotBookSchema } from "@gigit/domain";
import { ConcurrentUpdateError, db, runSubslotTransition, schema } from "@gigit/db";
import { and, eq, ne } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

/** The payer books an applicant tech: TECH_BOOKED → charged + confirmed. */
export async function POST(req: Request, { params }: Params) {
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

    const [performer, venue] = await Promise.all([
      performerOwnedBy(userId),
      venueOwnedBy(userId),
    ]);
    const isPayer =
      row.subslot.payer === "venue"
        ? venue?.id === row.booking.venueId
        : performer?.id === row.booking.performerId;
    if (!isPayer) return fail("forbidden", "only the paying side can book the tech", 403);

    const parsed = await parseBody(req, techSubslotBookSchema);
    if ("response" in parsed) return parsed.response;
    const { techId } = parsed.data;

    const [application] = await d
      .select()
      .from(schema.techSubslotApplications)
      .where(
        and(
          eq(schema.techSubslotApplications.subslotId, subslotId),
          eq(schema.techSubslotApplications.techId, techId),
        ),
      );
    if (!application) return fail("not_found", "that tech has not applied", 404);

    const result = await runSubslotTransition(
      subslotId,
      { kind: "TECH_BOOKED", techId },
      userId,
    );
    await d
      .update(schema.techSubslotApplications)
      .set({ status: "booked" })
      .where(eq(schema.techSubslotApplications.id, application.id));
    await d
      .update(schema.techSubslotApplications)
      .set({ status: "declined" })
      .where(
        and(
          eq(schema.techSubslotApplications.subslotId, subslotId),
          ne(schema.techSubslotApplications.id, application.id),
        ),
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
