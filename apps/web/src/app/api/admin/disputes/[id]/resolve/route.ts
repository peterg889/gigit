import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  InvalidResolutionError,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const faultSchema = z.enum(["venue", "performer", "neither"]).default("neither");
const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release_full"), fault: faultSchema }),
  z.object({ kind: z.literal("refund_full"), fault: faultSchema }),
  z.object({
    kind: z.literal("partial"),
    releaseCents: z.number().int().min(0),
    refundCents: z.number().int().min(0),
    fault: faultSchema,
  }),
]);

/** Ops adjudication (F7.4). AI drafts the brief later; a human always decides. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireUser();
    if (!(await isAdmin(userId))) return fail("forbidden", "admin only", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const resolution = parsed.data;

    if (resolution.kind === "partial") {
      const [booking] = await db()
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, bookingId));
      if (!booking) return fail("not_found", "booking not found", 404);
      if (
        resolution.releaseCents + resolution.refundCents !==
        booking.terms.amountCents
      )
        return fail(
          "validation",
          "partial resolution must sum to the booking amount",
          422,
        );
    }

    const result = await runBookingTransition(
      bookingId,
      { kind: "DISPUTE_RESOLVED", resolution },
      userId,
    );
    return ok({ state: result.to });
  } catch (e) {
    if (e instanceof IllegalTransitionError)
      return fail("illegal_transition", "booking is not disputed", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "retry", 409);
    if (e instanceof InvalidResolutionError) return fail("validation", e.message, 422);
    return respondError(e);
  }
}
