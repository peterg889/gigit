import { appendEvent, db, recordLedgerEntry, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireUser, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({
  direction: z.enum(["refund_venue", "pay_performer"]),
  amountCents: z.number().int().min(1),
  reason: z.string().min(5).max(500),
});

/**
 * Manual money adjustment (F9.1): always a ledger row with a reason, never a
 * silent edit. External movement follows the same gateway path as everything
 * else (Null in dev; Stripe executes on the next reconciliation pass).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const adminId = await requireUser();
    if (!(await isAdmin(adminId))) return fail("forbidden", "admin only", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { direction, amountCents, reason } = parsed.data;

    const d = db();
    const [booking] = await d
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "booking not found", 404);

    await recordLedgerEntry(d, {
      bookingId,
      entryType: "adjustment",
      debitParty: "platform",
      creditParty:
        direction === "refund_venue"
          ? `venue:${booking.venueId}`
          : `performer:${booking.performerId}`,
      amountCents,
      idempotencyKey: `${bookingId}:adjustment:${Date.now()}`,
    });
    await appendEvent(d, {
      actor: adminId,
      kind: "booking.adjustment",
      subjectType: "booking",
      subjectId: bookingId,
      payload: { direction, amountCents, reason },
    });
    return ok({ bookingId, direction, amountCents });
  } catch (e) {
    return respondError(e);
  }
}
