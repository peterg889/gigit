import { createHash } from "node:crypto";
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
    if (!(await isAdmin(adminId))) return fail("forbidden", "That page is for EightGig staff.", 403);

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { direction, amountCents, reason } = parsed.data;

    const d = db();
    const [booking] = await d
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!booking) return fail("not_found", "We couldn't find that booking.", 404);

    // Key off the CONTENT, not the clock. `Date.now()` meant a double-clicked
    // adjustment 2ms apart wrote two ledger rows, while inside the same
    // millisecond the conflict guard silently dropped the ledger row and the
    // route still recorded the event and returned 200 — so the audit trail and
    // the money disagreed in both directions. Identical resubmits now dedupe;
    // a genuinely different correction has different content.
    const fingerprint = createHash("sha256")
      .update(`${direction}|${amountCents}|${reason ?? ""}`)
      .digest("hex")
      .slice(0, 16);
    // One transaction, so the ledger row and its audit event commit together.
    await d.transaction(async (tx) => {
      await recordLedgerEntry(tx, {
        bookingId,
        entryType: "adjustment",
        debitParty: "platform",
        creditParty:
          direction === "refund_venue"
            ? `venue:${booking.venueId}`
            : `performer:${booking.performerId}`,
        amountCents,
        idempotencyKey: `${bookingId}:adjustment:${fingerprint}`,
      });
      await appendEvent(tx, {
        actor: adminId,
        kind: "booking.adjustment",
        subjectType: "booking",
        subjectId: bookingId,
        payload: { direction, amountCents, reason },
      });
    });
    return ok({ bookingId, direction, amountCents });
  } catch (e) {
    return respondError(e);
  }
}
