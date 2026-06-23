/**
 * Data-layer jobs the worker schedules (extracted so the integration suite
 * can exercise them — the worker is a scheduler/interpreter, not a home for
 * business SQL).
 */
import { getPool } from "./client.js";

/**
 * ROI-loop baseline (PRD F8.5-P0): one row per venue per night, gig or not.
 * Idempotent on (venue, night).
 */
export async function snapshotNightFacts(nightDate?: string): Promise<number> {
  const night =
    nightDate ?? new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
  const { rowCount } = await getPool().query(
    `insert into venue_night_facts
       (venue_id, night_date, day_of_week, had_booking, booking_id, format, budget_cents)
     select v.id, $1::text, extract(dow from $1::date)::int,
            b.id is not null, b.id, s.format, (b.terms->>'amountCents')::int
       from venues v
       left join lateral (
         select * from bookings bk
          where bk.venue_id = v.id
            and bk.state in ('confirmed','awaiting_confirmation','released',
                             'disputed','partially_released')
            and (bk.terms->>'startsAt')::timestamptz >= $1::date
            and (bk.terms->>'startsAt')::timestamptz < ($1::date + interval '1 day')
          order by (bk.terms->>'startsAt')::timestamptz
          limit 1
       ) b on true
       left join slots s on s.id = b.slot_id
     on conflict (venue_id, night_date) do nothing`,
    [night],
  );
  return rowCount ?? 0;
}

/**
 * Saved-search matching (PRD F2.3): which users should hear about this slot.
 * `either`-format slots match any format preference.
 */
export async function matchSavedSearches(slotId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `select distinct p.owner_user_id
       from saved_searches ss
       join performers p on p.id = ss.performer_id
       join slots s on s.id = $1
      where (ss.format is null or ss.format = s.format or s.format = 'either')
        and (ss.metro is null or ss.metro = s.metro)
        and (ss.min_budget_cents is null or s.budget_cents >= ss.min_budget_cents)`,
    [slotId],
  );
  return rows.map((r) => r.owner_user_id);
}

/**
 * Reverse of matchSavedSearches (PRD F2.4, anti-leakage): when a new act joins,
 * which venue owners have an OPEN, future slot it fits? This is the "next new
 * act" half of the feed moat — the reason a venue comes back even between its
 * own posts. Scoped to an actual open slot so the alert is always actionable,
 * never metro-wide spam. Format maps performer kind → slot format (comedian →
 * comedy, else music); `either` slots match anyone; budget floor respected.
 */
export async function matchOpenSlotsForPerformer(
  performerId: string,
): Promise<string[]> {
  const { rows } = await getPool().query(
    `select distinct v.owner_user_id
       from performers p
       join slots s
         on s.status = 'open'
        and s.starts_at >= now()
        and s.metro = p.home_metro
        and (s.format = 'either'
             or s.format = (case when p.kind = 'comedian' then 'comedy' else 'music' end))
        and (p.rate_min_cents is null or s.budget_cents >= p.rate_min_cents)
       join venues v on v.id = s.venue_id
      where p.id = $1
        and v.owner_user_id is not null`,
    [performerId],
  );
  return rows.map((r) => r.owner_user_id);
}
