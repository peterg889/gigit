/**
 * Intent ledger (engineering-spec K3): Stripe holds the funds; this table is
 * the record of who is owed what and why. Append-only; idempotency keys make
 * every write safe to retry. Invariant (tested): at terminal booking states,
 * charge total == base release + refund + fee. Explicit admin adjustments are
 * reported separately because they are additional movements, not a way to
 * rewrite or conceal the booking's contractual settlement.
 */
import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { ledgerEntries } from "./schema.js";

export type EntryType = "charge" | "release" | "refund" | "fee" | "adjustment";

export interface LedgerWrite {
  bookingId: string;
  entryType: EntryType;
  debitParty: string;
  creditParty: string;
  amountCents: number;
  paymentRef?: string;
  /** defaults to `${bookingId}:${entryType}` — one entry of each type per booking */
  idempotencyKey?: string;
}

/** True only when this call inserted the intent; false for a replay or zero value. */
export async function recordLedgerEntry(
  tx: Tx | Db,
  w: LedgerWrite,
): Promise<boolean> {
  if (w.amountCents <= 0) return false; // zero-amount intents are not recorded
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      bookingId: w.bookingId,
      entryType: w.entryType,
      debitParty: w.debitParty,
      creditParty: w.creditParty,
      amountCents: w.amountCents,
      paymentRef: w.paymentRef ?? null,
      idempotencyKey: w.idempotencyKey ?? `${w.bookingId}:${w.entryType}`,
    })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });
  return inserted.length > 0;
}

export interface BookingLedgerSummary {
  chargedCents: number;
  releasedCents: number;
  refundedCents: number;
  /**
   * Explicit extra platform-funded admin movements. This is deliberately not
   * part of the base booking conservation equation above.
   */
  adjustedCents: number;
}

export async function bookingLedger(
  d: Db | Tx,
  bookingId: string,
): Promise<BookingLedgerSummary> {
  const rows = await d
    .select({
      entryType: ledgerEntries.entryType,
      total: sql<number>`sum(${ledgerEntries.amountCents})::int`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.bookingId, bookingId))
    .groupBy(ledgerEntries.entryType);
  const get = (t: EntryType) => rows.find((r) => r.entryType === t)?.total ?? 0;
  return {
    chargedCents: get("charge"),
    releasedCents: get("release") + get("fee"),
    refundedCents: get("refund"),
    adjustedCents: get("adjustment"),
  };
}
