import { newId, reviewCreateSchema } from "@gigit/domain";
import { appendEvent, db, pgErrorCode, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

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
    if (!row) return fail("not_found", "sound booking not found", 404);
    if (row.subslot.state !== "released")
      return fail("conflict", "reviews open after the sound gig is completed", 409);

    const [venue, performer, tech] = await Promise.all([
      venueOwnedBy(userId),
      performerOwnedBy(userId),
      techOwnedBy(userId),
    ]);
    let authorRole: "payer" | "tech";
    if (tech?.id === row.subslot.techId) authorRole = "tech";
    else {
      const isPayer = row.subslot.payer === "venue"
        ? venue?.id === row.booking.venueId
        : performer?.id === row.booking.performerId;
      if (!isPayer) return fail("forbidden", "not a party to this sound booking", 403);
      authorRole = "payer";
    }

    const parsed = await parseBody(req, reviewCreateSchema);
    if ("response" in parsed) return parsed.response;
    const id = newId("message");
    try {
      await d.insert(schema.techSubslotReviews).values({
        id,
        subslotId,
        authorRole,
        ratings: parsed.data.ratings,
        body: parsed.data.body,
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        return fail("conflict", "you already reviewed this sound booking", 409);
      throw error;
    }
    await appendEvent(d, {
      actor: userId,
      kind: "subslot.review_submitted",
      subjectType: "tech_subslot",
      subjectId: subslotId,
      payload: { authorRole, overall: parsed.data.ratings.overall },
    });
    return ok({ id }, 201);
  } catch (error) {
    return respondError(error);
  }
}
