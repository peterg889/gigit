import { appendEvent, db, paymentsEnabled, recordLedgerEntry, schema } from "@gigit/db";
import { MONEY_SETTLED_STATES, type Effect } from "@gigit/domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, respondError } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };
const MAX_LEDGER_AMOUNT_CENTS = 2_147_483_647;

const bodySchema = z.object({
  direction: z.enum(["refund_venue", "pay_performer"]),
  amountCents: z.number().int().min(1).max(MAX_LEDGER_AMOUNT_CENTS),
  reason: z.string().trim().min(5).max(500),
  idempotencyKey: z.string().trim().min(8).max(200),
});

class AdjustmentIdempotencyConflictError extends Error {}

/**
 * Manual money adjustment (F9.1): ledger intent, audit reason, and executable
 * outbox effect commit together. The worker executes the effect through the
 * same payment gateway as lifecycle settlements.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: bookingId } = await params;
    const adminId = await requireAdmin();

    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const { direction, amountCents, reason, idempotencyKey } = parsed.data;

    if (!paymentsEnabled())
      return fail(
        "payments_disabled",
        "Money adjustments are unavailable while platform payments are turned off.",
        409,
      );

    const result = await db().transaction(async (tx) => {
      // Every adjustment for this booking takes the same row lock. That makes
      // the remaining-refund check and insert one decision even when two ops
      // requests submit at the same time.
      const [booking] = await tx
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, bookingId))
        .for("update");
      if (!booking) return { kind: "not_found" as const };

      const venueParty = `venue:${booking.venueId}`;
      const creditParty =
        direction === "refund_venue"
          ? venueParty
          : `performer:${booking.performerId}`;
      const parentChargeKey = `${bookingId}:charge`;
      const parentRefundKey = `${bookingId}:refund`;
      const ledgerKey = `${bookingId}:adjustment:${idempotencyKey}`;
      const effect: Effect =
        direction === "refund_venue"
          ? { kind: "refund_funds", amountCents, operationKey: idempotencyKey }
          : { kind: "release_funds", amountCents, operationKey: idempotencyKey };

      const [totals] = await tx
        .select({
          chargedCents: sql<number>`coalesce(sum(${schema.ledgerEntries.amountCents}) filter (where ${schema.ledgerEntries.entryType} = 'charge' and ${schema.ledgerEntries.idempotencyKey} = ${parentChargeKey} and ${schema.ledgerEntries.paymentRef} = ${booking.paymentRef}), 0)::int`,
          baseRefundedCents: sql<number>`coalesce(sum(${schema.ledgerEntries.amountCents}) filter (where ${schema.ledgerEntries.entryType} = 'refund' and ${schema.ledgerEntries.idempotencyKey} = ${parentRefundKey}), 0)::int`,
          manualVenueRefundedCents: sql<number>`coalesce(sum(${schema.ledgerEntries.amountCents}) filter (where ${schema.ledgerEntries.entryType} = 'adjustment' and ${schema.ledgerEntries.creditParty} = ${venueParty}), 0)::int`,
        })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.bookingId, bookingId));
      const chargedCents = Number(totals?.chargedCents ?? 0);
      if (chargedCents <= 0 || !booking.paymentRef)
        return { kind: "not_charged" as const };
      if (
        direction === "refund_venue" &&
        !MONEY_SETTLED_STATES.some((state) => state === booking.state)
      )
        return { kind: "refund_not_settled" as const };

      // The caller owns the operation key: a transport retry reuses it, while
      // a second intentional adjustment gets a new one even when its content
      // is identical. Check a replay before applying the refund ceiling — its
      // amount is already included in the aggregate above.
      const [existingLedger] = await tx
        .select()
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.idempotencyKey, ledgerKey));
      if (existingLedger) {
        const [existingEvent] = await tx
          .select({ payload: schema.events.payload })
          .from(schema.events)
          .where(
            and(
              // Leads the events_subject_idx (subject_type, subject_id, id).
              // Omitting it drops this to a sequential scan of the whole events
              // table — inside a transaction, on the idempotency check.
              eq(schema.events.subjectType, "booking"),
              eq(schema.events.kind, "booking.adjustment"),
              eq(schema.events.subjectId, bookingId),
              sql`${schema.events.payload}->>'idempotencyKey' = ${idempotencyKey}`,
            ),
          );
        if (
          existingLedger.bookingId !== bookingId ||
          existingLedger.entryType !== "adjustment" ||
          existingLedger.debitParty !== "platform" ||
          existingLedger.creditParty !== creditParty ||
          existingLedger.amountCents !== amountCents ||
          existingEvent?.payload.direction !== direction ||
          existingEvent.payload.amountCents !== amountCents ||
          existingEvent.payload.reason !== reason
        )
          throw new AdjustmentIdempotencyConflictError();
        return { kind: "duplicate" as const };
      }

      if (direction === "refund_venue") {
        const alreadyRefunded =
          Number(totals?.baseRefundedCents ?? 0) +
          Number(totals?.manualVenueRefundedCents ?? 0);
        const availableCents = Math.max(0, chargedCents - alreadyRefunded);
        if (amountCents > availableCents)
          return { kind: "refund_exceeds_charge" as const, availableCents };
      }

      const inserted = await recordLedgerEntry(tx, {
        bookingId,
        entryType: "adjustment",
        debitParty: "platform",
        creditParty,
        amountCents,
        idempotencyKey: ledgerKey,
      });
      if (!inserted) throw new AdjustmentIdempotencyConflictError();
      await appendEvent(tx, {
        actor: adminId,
        kind: "booking.adjustment",
        subjectType: "booking",
        subjectId: bookingId,
        payload: {
          direction,
          amountCents,
          reason,
          idempotencyKey,
          effects: [effect],
        },
      });
      return { kind: "created" as const };
    });

    if (result.kind === "not_found")
      return fail("not_found", "We couldn't find that booking.", 404);
    if (result.kind === "not_charged")
      return fail(
        "booking_not_charged",
        "This booking has no completed platform charge to adjust.",
        409,
      );
    if (result.kind === "refund_not_settled")
      return fail(
        "refund_not_settled",
        "Finish the booking's cancellation or settlement before refunding the venue.",
        409,
      );
    if (result.kind === "refund_exceeds_charge")
      return fail(
        "refund_exceeds_charge",
        `Only $${(result.availableCents / 100).toFixed(2)} remains refundable on the original charge.`,
        409,
      );
    return ok({
      bookingId,
      direction,
      amountCents,
      duplicate: result.kind === "duplicate",
    });
  } catch (e) {
    if (e instanceof AdjustmentIdempotencyConflictError)
      return fail(
        "idempotency_conflict",
        "That request was already used for a different adjustment. Refresh and try again.",
        409,
      );
    return respondError(e);
  }
}
