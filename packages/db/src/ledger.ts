/**
 * Intent ledger (engineering-spec K3): Stripe holds the funds; this table is
 * the record of who is owed what and why. Append-only; idempotency keys make
 * every write safe to retry. Invariant (tested): at terminal booking states,
 * charge total == release total + refund total.
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

export async function recordLedgerEntry(
  tx: Tx | Db,
  w: LedgerWrite,
): Promise<void> {
  if (w.amountCents <= 0) return; // zero-amount intents are not recorded
  await tx
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
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey });
}

export interface BookingLedgerSummary {
  chargedCents: number;
  releasedCents: number;
  refundedCents: number;
  /** Manual admin corrections. Omitting these made the one entry type a human
   *  types a free-form number into invisible to the only balance summary. */
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
