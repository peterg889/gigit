/**
 * Data-layer jobs the worker schedules (extracted so the integration suite
 * can exercise them — the worker is a scheduler/interpreter, not a home for
 * business SQL).
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { db, getPool } from "./client.js";
import { appendEvent } from "./events.js";
import { applications, slots } from "./schema.js";

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
 * `either` is a wildcard on BOTH sides: an `either` slot matches any format
 * preference, and an `either` preference matches any slot format. The predicate
 * only handled the slot side, so the "Music or comedy" option the form offers
 * matched nothing but the rarest slot type — the exact inverse of its label.
 */
export async function matchSavedSearches(slotId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `select distinct p.owner_user_id
       from saved_searches ss
       join performers p on p.id = ss.performer_id
       join users recipient
         on recipient.id = p.owner_user_id
        and recipient.status = 'active'
       join slots s on s.id = $1
       join venues source_venue
         on source_venue.id = s.venue_id
        and source_venue.status = 'live'
       join users source_owner
         on source_owner.id = source_venue.owner_user_id
        and source_owner.status = 'active'
      where (ss.format is null or ss.format = 'either'
             or s.format = 'either' or ss.format = s.format)
        and (ss.metro is null or ss.metro = s.metro)
        and (ss.min_budget_cents is null or s.budget_cents >= ss.min_budget_cents)
        and p.status = 'live'
        and s.status = 'open'
        and s.starts_at > now()`,
    [slotId],
  );
  return rows.map((r) => r.owner_user_id);
}

export interface StaleSlot {
  slotId: string;
  ownerUserId: string;
}

/**
 * Re-engagement sweep (PRD F2.3, anti-leakage): open slots still unfilled 48h
 * after posting, with a future gig date and zero applicants, that haven't been
 * nudged yet. The daily worker job pulls these venues back to the feed — the
 * feed is the moat with payments deferred. Dedup is a one-per-slot
 * `slot.reengaged` event (appended after the nudge), so a long-open slot is
 * nudged once, not every night.
 */
/**
 * Age out open nights whose date has passed.
 *
 * Nothing ever wrote `slots.status = 'expired'`, so a night that came and went
 * unfilled stayed `open` forever: /slots/[id] kept rendering an apply form for a
 * gig in the past, and the admin fill-rate denominator counted every dead slot
 * for good. Idempotent — only `open` rows move.
 */
export async function expirePastSlots(now: Date = new Date()): Promise<number> {
  return db().transaction(async (tx) => {
    const expired = await tx
      .update(slots)
      .set({ status: "expired" })
      .where(and(eq(slots.status, "open"), lte(slots.startsAt, now)))
      .returning({ id: slots.id });
    if (expired.length === 0) return 0;

    // A past night is no longer actionable. Close every still-pending
    // application in the same transaction and use the ordinary decline event
    // shape so each act gets a definitive answer instead of "Pending" forever.
    // The offered application is resolved by its booking's OFFER_EXPIRED
    // transition, avoiding two notifications for the same offer.
    const resolved = await tx
      .update(applications)
      .set({ status: "declined", declineReason: "slot_expired" })
      .where(
        and(
          inArray(
            applications.slotId,
            expired.map((slot) => slot.id),
          ),
          eq(applications.status, "submitted"),
        ),
      )
      .returning({ id: applications.id, slotId: applications.slotId });
    for (const application of resolved)
      await appendEvent(tx, {
        actor: "system",
        kind: "application.declined",
        subjectType: "slot",
        subjectId: application.slotId,
        payload: {
          applicationId: application.id,
          reason: "slot_expired",
          effects: [
            { kind: "notify", template: "application_expired", to: "performer" },
          ],
        },
      });

    return expired.length;
  });
}

export async function staleOpenSlots(): Promise<StaleSlot[]> {
  const { rows } = await getPool().query(
    `select s.id as slot_id, v.owner_user_id
       from slots s
       join venues v
         on v.id = s.venue_id
        and v.status = 'live'
       join users owner
         on owner.id = v.owner_user_id
        and owner.status = 'active'
      where s.status = 'open'
        and s.starts_at > now()
        and s.created_at < now() - interval '48 hours'
        and v.owner_user_id is not null
        and not exists (select 1 from applications a where a.slot_id = s.id)
        and not exists (
          select 1 from events e
           where e.kind = 'slot.reengaged' and e.subject_id = s.id
        )`,
  );
  return rows.map((r) => ({ slotId: r.slot_id, ownerUserId: r.owner_user_id }));
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
       join users performer_owner
         on performer_owner.id = p.owner_user_id
        and performer_owner.status = 'active'
       join slots s
         on s.status = 'open'
        and s.starts_at >= now()
        and s.metro = p.home_metro
        and (s.format = 'either'
             or s.format = (case when p.kind = 'comedian' then 'comedy' else 'music' end))
        and (p.rate_min_cents is null or s.budget_cents >= p.rate_min_cents)
       join venues v
         on v.id = s.venue_id
        and v.status = 'live'
       join users venue_owner
         on venue_owner.id = v.owner_user_id
        and venue_owner.status = 'active'
      where p.id = $1
        and p.status = 'live'
        and v.owner_user_id is not null`,
    [performerId],
  );
  return rows.map((r) => r.owner_user_id);
}
