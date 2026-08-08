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
import { requireAdmin, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

const faultSchema = z.enum(["venue", "performer", "neither"]).default("neither");
const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release_full"), fault: faultSchema }),
  z.object({ kind: z.literal("refund_full"), fault: faultSchema }),
  z.object({
    kind: z.literal("partial"),
    releaseCents: z.number().int().positive(),
    refundCents: z.number().int().positive(),
    fault: faultSchema,
  }),
]);

/** Ops adjudication (F7.4). AI drafts the brief later; a human always decides. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const userId = await requireAdmin();

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const resolution = parsed.data;

    if (resolution.kind === "partial") {
      const [booking] = await db()
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, bookingId));
      if (!booking) return fail("not_found", "We couldn't find that booking.", 404);
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
      return fail("illegal_transition", "There's no open dispute on this booking.", 409);
    if (e instanceof ConcurrentUpdateError) return fail("conflict", "Something moved while you were working. Reload and try again.", 409);
    if (e instanceof InvalidResolutionError) return fail("validation", e.message, 422);
    return respondError(e);
  }
}
