import { db, getPool, paymentsEnabled } from "@gigit/db";
import Link from "next/link";
import { isAdmin } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Liquidity dashboard (F9.2) — the PRD §9 metrics as plain SQL over events/domain tables. */
export default async function AdminPage() {
  const userId = await sessionUserId();
  if (!userId || !(await isAdmin(userId)))
    return (
      <div className="card">
        Admin only. <Link href="/login">Sign in</Link>
      </div>
    );
  void db();
  const pool = getPool();
  const paymentsOn = paymentsEnabled();
  const q = async (sql: string) => (await pool.query(sql)).rows[0] ?? {};

  const slots = await q(`select
      count(*) filter (where status='open') as open,
      count(*) filter (where status='filled') as filled,
      count(*) filter (where status in ('open','filled')) as total
    from slots`);
  const fillRate =
    Number(slots.total) > 0
      ? ((Number(slots.filled) / Number(slots.total)) * 100).toFixed(0)
      : "—";
  const ttf = await q(`select round(extract(epoch from avg(b.created_at - s.created_at))/3600) as hours
    from bookings b join slots s on b.slot_id = s.id`);
  const apps = await q(`select round(avg(c),1) as depth from
    (select count(*) c from applications group by slot_id) t`);
  const bookings = await q(`select count(*) as total,
      count(*) filter (where state='confirmed') as confirmed,
      count(*) filter (where state='released') as released,
      count(*) filter (where state like 'cancelled%') as cancelled,
      count(*) filter (where state='disputed') as disputed
    from bookings`);
  const money = await q(`select
      coalesce(sum(amount_cents) filter (where entry_type='charge'),0)/100 as charged,
      coalesce(sum(amount_cents) filter (where entry_type in ('release','fee')),0)/100 as released,
      coalesce(sum(amount_cents) filter (where entry_type='refund'),0)/100 as refunded
    from ledger_entries`);
  const supply = await q(`select
      (select count(*) from performers) as performers,
      (select count(*) from venues) as venues,
      (select count(*) from techs) as techs`);

  const Row = ({ k, v }: { k: string; v: unknown }) => (
    <p>
      <span className="muted">{k}:</span> <strong>{String(v ?? "—")}</strong>
    </p>
  );

  return (
    <div>
      <h1>Liquidity</h1>
      <p className="muted">
        <Link href="/admin/search">Ops search</Link> ·{" "}
        <Link href="/admin/moderation">Moderation queue</Link>
      </p>
      <div className="card">
        <h2>Slots</h2>
        <Row k="Fill rate" v={`${fillRate}%`} />
        <Row k="Open now" v={slots.open} />
        <Row k="Median-ish time-to-fill (h)" v={ttf.hours} />
        <Row k="Avg applications per slot" v={apps.depth} />
      </div>
      <div className="card">
        <h2>Bookings</h2>
        <Row k="Total" v={bookings.total} />
        <Row k="Confirmed (upcoming)" v={bookings.confirmed} />
        <Row k="Released (completed)" v={bookings.released} />
        <Row k="Cancelled" v={bookings.cancelled} />
        <Row k="Disputed (a person needs to look)" v={bookings.disputed} />
      </div>
      <div className="card">
        <h2>{paymentsOn ? "Money (ledger)" : "Booked value (ledger)"}</h2>
        <Row k={paymentsOn ? "Charged ($)" : "Booked ($)"} v={money.charged} />
        <Row k={paymentsOn ? "Released ($)" : "Completed ($)"} v={money.released} />
        <Row k={paymentsOn ? "Refunded ($)" : "Reversed ($)"} v={money.refunded} />
        {!paymentsOn && (
          <p className="muted">
            Contract value accrued in the ledger — Gigit moves none of it while
            payments are off; the venue pays the act directly.
          </p>
        )}
      </div>
      <div className="card">
        <h2>The scene</h2>
        <Row k="Performers" v={supply.performers} />
        <Row k="Venues" v={supply.venues} />
        <Row k="Sound techs" v={supply.techs} />
      </div>
    </div>
  );
}
