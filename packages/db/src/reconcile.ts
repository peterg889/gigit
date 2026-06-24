/**
 * Nightly money reconciliation (engineering-spec §5 invariants, §12):
 *
 *  A. Ledger self-consistency — for every booking in a terminal state:
 *       Σ charge == Σ (release + refund + fee)        (invariant 1)
 *       any release/refund/fee implies a prior charge (invariant 2)
 *  B. Stripe cross-check (when configured) — every ledger charge's
 *     paymentRef must exist and be succeeded on Stripe.
 *
 * Mismatches are paged (error-level log → Sentry when configured) and
 * recorded as events so the ops dashboard can show them.
 */
import { db, getPool } from "./client.js";
import { env } from "./env.js";
import { appendEvent } from "./events.js";

export interface Mismatch {
  bookingId: string;
  kind: string;
  detail: Record<string, unknown>;
}

export async function reconcileMoney(): Promise<Mismatch[]> {
  const pool = getPool();
  const mismatches: Mismatch[] = [];

  // A1: terminal bookings must balance.
  const { rows: unbalanced } = await pool.query(`
    select b.id,
           coalesce(sum(l.amount_cents) filter (where l.entry_type = 'charge'), 0) as charged,
           coalesce(sum(l.amount_cents) filter (where l.entry_type in ('release','refund','fee')), 0) as settled
      from bookings b
      join ledger_entries l on l.booking_id = b.id
     where b.state in ('released','refunded','partially_released',
                       'cancelled_by_venue','cancelled_by_performer')
     group by b.id
    having coalesce(sum(l.amount_cents) filter (where l.entry_type = 'charge'), 0)
        <> coalesce(sum(l.amount_cents) filter (where l.entry_type in ('release','refund','fee')), 0)`);
  for (const r of unbalanced)
    mismatches.push({
      bookingId: r.id,
      kind: "unbalanced_terminal",
      detail: { charged: Number(r.charged), settled: Number(r.settled) },
    });

  // A2: settlement without a charge.
  const { rows: orphans } = await pool.query(`
    select distinct l.booking_id
      from ledger_entries l
     where l.entry_type in ('release','refund','fee')
       and not exists (
         select 1 from ledger_entries c
          where c.booking_id = l.booking_id and c.entry_type = 'charge')`);
  for (const r of orphans)
    mismatches.push({ bookingId: r.booking_id, kind: "settlement_without_charge", detail: {} });

  // B: Stripe cross-check, bounded to the last 200 charges.
  const key = env().STRIPE_SECRET_KEY;
  if (key) {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(key);
    const { rows: charges } = await pool.query(`
      select booking_id, payment_ref from ledger_entries
       where entry_type = 'charge' and payment_ref like 'pi_%'
       order by id desc limit 200`);
    for (const c of charges) {
      try {
        const pi = await stripe.paymentIntents.retrieve(c.payment_ref);
        if (pi.status !== "succeeded")
          mismatches.push({
            bookingId: c.booking_id,
            kind: "stripe_charge_not_succeeded",
            detail: { paymentRef: c.payment_ref, status: pi.status },
          });
      } catch (err) {
        mismatches.push({
          bookingId: c.booking_id,
          kind: "stripe_charge_missing",
          detail: { paymentRef: c.payment_ref, error: String(err) },
        });
      }
    }
  }

  for (const m of mismatches) {
    await appendEvent(db(), {
      actor: "worker",
      kind: "reconciliation.mismatch",
      subjectType: "booking",
      subjectId: m.bookingId,
      payload: { kind: m.kind, ...m.detail },
    });
  }
  return mismatches;
}

/** Outbox lag: undispatched events older than this many ms = unhealthy. */
export async function outboxLagMs(): Promise<number> {
  const { rows } = await getPool().query(
    `select coalesce(extract(epoch from now() - min(occurred_at)) * 1000, 0) as lag
       from events where dispatched_at is null and dead_lettered_at is null`,
  );
  return Math.round(Number(rows[0]?.lag ?? 0));
}
