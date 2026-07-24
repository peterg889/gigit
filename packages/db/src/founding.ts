/**
 * Founding-Member tracking (marketing promise → durable record).
 *
 * The offer: the first FOUNDING_LIMIT acts and the first FOUNDING_LIMIT venues
 * to onboard become Founding Members and never pay a membership fee. To honor
 * that when billing eventually turns on, we must KNOW who qualifies — so each
 * performer/venue gets a monotonic signup rank (`foundingNumber`) at creation,
 * and `foundingMember = foundingNumber <= FOUNDING_LIMIT`.
 *
 * Assignment is atomic: a per-side advisory lock inside the creation
 * transaction serializes concurrent signups, and the number comes from
 * MAX(founding_number)+1 over committed rows — so a rolled-back creation leaves
 * no gap (unlike a raw sequence). Techs are deliberately excluded: the offer is
 * acts + venues only.
 *
 * IMPORTANT: `foundingMember` is a STORED boolean, frozen at grant time. Reads
 * must use the stored column (performer.foundingMember), never recompute from
 * the number — so changing FOUNDING_LIMIT later only affects NEW signups and
 * never revokes an existing member. `isFoundingMember(number)` below is the
 * grant-time predicate ONLY (what assignFounding writes into the column).
 */
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { performers, venues } from "./schema.js";

export const FOUNDING_LIMIT = 500;

type Side = "performer" | "venue";

// Stable per-side keys for pg_advisory_xact_lock (arbitrary distinct ints).
const LOCK_KEY: Record<Side, number> = { performer: 8801, venue: 8802 };

export interface FoundingAssignment {
  foundingNumber: number;
  foundingMember: boolean;
}

/**
 * Reserve the next founding rank for `side` inside the caller's transaction.
 * MUST run in the same transaction as the profile insert so the lock and the
 * MAX() see a consistent view and the number commits atomically with the row.
 */
export async function assignFounding(
  // drizzle's tx type is heavily generic; the runtime shape is all we need.
  tx: PgTransaction<any, any, any>,
  side: Side,
): Promise<FoundingAssignment> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY[side]})`);
  const table = side === "performer" ? performers : venues;
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${table.foundingNumber}), 0) + 1` })
    .from(table);
  const foundingNumber = Number(row?.next ?? 1);
  return { foundingNumber, foundingMember: isFoundingMember(foundingNumber) };
}

/**
 * Grant-time predicate: would a profile at this rank be a Founding Member under
 * the CURRENT limit? Used only when assigning the stored boolean. Do NOT call
 * this to decide an existing member's status — read the stored `foundingMember`
 * column, which is frozen and immune to a later limit change.
 */
export function isFoundingMember(foundingNumber: number | null | undefined): boolean {
  return foundingNumber != null && foundingNumber <= FOUNDING_LIMIT;
}
