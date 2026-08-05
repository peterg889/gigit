/**
 * Recurring slot series (PRD F2.2): create → materialize next N occurrences
 * as ordinary slots; a daily worker sweep keeps the horizon topped up as
 * occurrences pass. Cancelling a series cancels its future unfilled slots;
 * filled bookings are untouched (they're contracts).
 */
import { and, eq, gt } from "drizzle-orm";
import {
  FELL_THROUGH_STATES, newId, nextOccurrences } from "@gigit/domain";
import type { SeriesPattern } from "@gigit/domain";
import type { Db, Tx } from "./client.js";
import { db, getPool } from "./client.js";
import { appendEvent } from "./events.js";
import { lockActiveProfileOwners } from "./account-gate.js";
import { cancelOpenSlots } from "./slot-cancellation.js";
import { slotSeries, slots } from "./schema.js";

export const SERIES_HORIZON = 4; // occurrences kept open ahead (spec lean: next-N)

export interface RebookTarget {
  slotId: string;
  startsAt: Date;
  durationMinutes: number;
  performerId: string;
  venueId: string;
  amountCents: number;
  provides: { pa?: boolean; meal?: boolean; parking?: boolean };
  notes: string | null;
}

/**
 * Recurring-series re-book (PRD F2.2, anti-leakage): from a booking the venue
 * actually engaged, find the soonest compatible OPEN future date at the same
 * venue, preferring the same series when there is one, at that target night's
 * advertised pay — provided
 * the format fits the act and the night has no active booking or existing
 * application from this act. Residencies are the #1 leakage case
 * (a16z/Hagiu-Wright); re-booking the next night in one tap keeps it on-platform.
 * Returns null when the booking isn't rebook-eligible (must be confirmed or
 * later) or the room has no compatible open night ahead.
 */
export async function findRebookTarget(
  bookingId: string,
): Promise<RebookTarget | null> {
  const { rows } = await getPool().query(
    `select tgt.id as slot_id, tgt.starts_at, tgt.duration_minutes, tgt.provides, tgt.notes,
            b.performer_id, b.venue_id, tgt.budget_cents as amount_cents
       from bookings b
       join slots orig on orig.id = b.slot_id
       join performers p on p.id = b.performer_id
       join users performer_owner on performer_owner.id = p.owner_user_id
       join lateral (
         select s.id, s.starts_at, s.duration_minutes, s.budget_cents, s.provides, s.notes
           from slots s
          -- Same ROOM, not same series. Requiring a series meant a venue that
          -- posted a one-off and loved the act had no rebook path at all — and
          -- the one-off venue is the majority at launch. A residency still
          -- prefers its own series via the ordering below.
          where s.venue_id = orig.venue_id
            and s.status = 'open'
            and s.starts_at > now()
            -- Use the same kind-to-format rule as discovery. Either is a
            -- wildcard; a music act must never be suggested for comedy night,
            -- nor a comedian for a music night.
            and (s.format = 'either'
                 or s.format = case when p.kind = 'comedian'
                                    then 'comedy' else 'music' end)
            and not exists (
              select 1 from bookings b2
               where b2.slot_id = s.id
                 and b2.state <> all($2::text[])
            )
            and not exists (
              select 1 from applications a
               where a.slot_id = s.id and a.performer_id = b.performer_id
            )
          order by
            -- A one-off candidate has a null series_id. PostgreSQL sorts nulls
            -- first for DESC, so the bare boolean expression accidentally put
            -- every one-off ahead of TRUE (the original series). Collapse the
            -- unknown case to false before applying the preference.
            coalesce(
              orig.series_id is not null and s.series_id = orig.series_id,
              false
            ) desc,
            s.starts_at asc
          limit 1
       ) tgt on true
      where b.id = $1
        and b.state in ('confirmed','awaiting_confirmation','released','partially_released')
        -- Re-book is a venue-initiated firm offer. Hidden acts and owners who
        -- are suspended/deactivated cannot review or accept it, so an old
        -- released booking must not bypass the invite route's live-act rule.
        and p.status = 'live'
        and performer_owner.status = 'active'`,
    [bookingId, [...FELL_THROUGH_STATES]],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    slotId: r.slot_id,
    startsAt: r.starts_at,
    durationMinutes: r.duration_minutes,
    performerId: r.performer_id,
    venueId: r.venue_id,
    amountCents: r.amount_cents,
    provides: r.provides,
    notes: r.notes,
  };
}

export interface CreateSeriesInput {
  venueId: string;
  metro: string;
  actor: string;
  pattern: SeriesPattern;
  defaults: {
    format: string;
    genrePrefs: string[];
    budgetCents: number;
    provides: { pa?: boolean; meal?: boolean; parking?: boolean };
    notes?: string;
  };
}

export async function createSeries(input: CreateSeriesInput): Promise<string> {
  const id = newId("series");
  await db().transaction(async (tx) => {
    const active = await lockActiveProfileOwners(tx, {
      venueIds: [input.venueId],
      additionalUserIds: [input.actor],
    });
    const venue = active.venues.get(input.venueId)!;
    await tx.insert(slotSeries).values({
      id,
      venueId: venue.id,
      metro: venue.metro,
      pattern: input.pattern,
      defaults: input.defaults,
    });
    await appendEvent(tx, {
      actor: input.actor,
      kind: "series.created",
      subjectType: "series",
      subjectId: id,
      payload: { pattern: input.pattern },
    });
    // The first horizon is part of series creation. Keeping it in this
    // transaction avoids a successful but empty series when materialization
    // fails, and keeps the account/profile gate held through every slot.
    await materializeSeriesInTx(tx, id, input.actor);
  });
  return id;
}

async function materializeSeriesInTx(
  tx: Tx,
  seriesId: string,
  actor: string,
): Promise<number> {
  // Cancellation takes this same lock. A worker that read an active series
  // just before cancellation therefore cannot materialize a fresh open date
  // after the series has been taken down.
  const [series] = await tx
    .select()
    .from(slotSeries)
    .where(eq(slotSeries.id, seriesId))
    .for("update");
  if (!series || series.status !== "active") return 0;

  const occurrences = nextOccurrences(
    series.pattern as SeriesPattern,
    new Date(),
    SERIES_HORIZON,
  );
  let created = 0;
  for (const startsAt of occurrences) {
    const slotId = newId("slot");
    const inserted = await tx
      .insert(slots)
      .values({
        id: slotId,
        venueId: series.venueId,
        seriesId: series.id,
        metro: series.metro,
        startsAt,
        durationMinutes: series.pattern.durationMinutes,
        format: series.defaults.format,
        genrePrefs: series.defaults.genrePrefs,
        budgetCents: series.defaults.budgetCents,
        provides: series.defaults.provides,
        notes: series.defaults.notes ?? null,
        source: "series",
      })
      .onConflictDoNothing({
        target: [slots.seriesId, slots.startsAt],
      })
      .returning({ id: slots.id });
    if (inserted.length > 0) {
      created += 1;
      await appendEvent(tx, {
        actor,
        kind: "slot.created",
        subjectType: "slot",
        subjectId: slotId,
        payload: { seriesId: series.id, source: "series" },
      });
    }
  }
  return created;
}

/** Top a series up to SERIES_HORIZON future open occurrences. Idempotent. */
export async function materializeSeries(
  seriesId: string,
  actor: string,
): Promise<number> {
  return db().transaction(async (tx) => {
    // Discover the immutable venue ID without a resource lock, then take the
    // account/profile gate before the series lock. Deactivation and every
    // creator therefore share user/profile → resource ordering.
    const [candidate] = await tx
      .select({ venueId: slotSeries.venueId })
      .from(slotSeries)
      .where(eq(slotSeries.id, seriesId));
    if (!candidate) return 0;
    await lockActiveProfileOwners(tx, { venueIds: [candidate.venueId] });
    return materializeSeriesInTx(tx, seriesId, actor);
  });
}

/** Daily sweep: keep every active series at full horizon. */
export async function materializeAllActiveSeries(actor = "worker"): Promise<number> {
  const d = db();
  const active = await d
    .select({ id: slotSeries.id })
    .from(slotSeries)
    .where(eq(slotSeries.status, "active"));
  let total = 0;
  for (const s of active) {
    // One broken series (bad pattern, transient insert failure) must not stop
    // the sweep — every other venue's recurring nights still materialize.
    try {
      total += await materializeSeries(s.id, actor);
    } catch (err) {
      console.error(
        JSON.stringify({ kind: "series.materialize_failed", seriesId: s.id, err: String(err) }),
      );
    }
  }
  return total;
}

/** Cancel the series and its future, unfilled, unbooked occurrences. */
export async function cancelSeries(
  seriesId: string,
  actor: string,
  existingTx?: Tx,
): Promise<number> {
  const apply = async (tx: Tx) => {
    // Serialize with materialization, then leave the entire series untouched
    // if any occurrence still has a live offer or booking.
    const [series] = await tx
      .select({ id: slotSeries.id, status: slotSeries.status })
      .from(slotSeries)
      .where(eq(slotSeries.id, seriesId))
      .for("update");
    if (!series || series.status !== "active") return 0;

    const open = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(
        and(
          eq(slots.seriesId, seriesId),
          eq(slots.status, "open"),
          gt(slots.startsAt, new Date()),
        ),
      );
    const cancelled = await cancelOpenSlots(
      {
        slotIds: open.map((slot) => slot.id),
        actor,
        reason: "series_cancelled",
      },
      tx,
    );
    await tx
      .update(slotSeries)
      .set({ status: "cancelled" })
      .where(eq(slotSeries.id, seriesId));
    await appendEvent(tx, {
      actor,
      kind: "series.cancelled",
      subjectType: "series",
      subjectId: seriesId,
      payload: { slotsCancelled: cancelled },
    });
    return cancelled;
  };
  return existingTx ? apply(existingTx) : db().transaction(apply);
}

/** A venue's series with their next open occurrence, for the profile page. */
export async function seriesForVenue(d: Db, venueId: string) {
  return d
    .select()
    .from(slotSeries)
    .where(and(eq(slotSeries.venueId, venueId), eq(slotSeries.status, "active")));
}
