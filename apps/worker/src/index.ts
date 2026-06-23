/**
 * Gigit worker (engineering-spec §5 worker):
 *  1. Outbox dispatcher — polls `events` rows with dispatched_at IS NULL,
 *     interprets effects (notify, schedule, request_payment).
 *  2. pg-boss — booking timers (offer expiry, gig end, auto-confirm).
 *  3. Reconciler — re-derives missing timers from booking state every 10 min,
 *     so a killed worker loses nothing (M0 exit criterion 4).
 * No inbound surface; webhooks land at the web service.
 */
import {
  env,
  db,
  appendEvent,
  closeDb,
  getPool,
  runBookingTransition,
  paymentGateway,
  materializeAllActiveSeries,
  cascadeParentToSubslots,
  IllegalTransitionError,
  BookingNotFoundError,
} from "@gigit/db";
import type { BookingEvent, Effect } from "@gigit/domain";
import PgBoss from "pg-boss";
import * as Sentry from "@sentry/node";
import { notifyBookingParties, notifySubslotParties, notifyUser } from "./notify.js";
import { recheckEmbeds, screenMedia } from "./media.js";
import {
  matchSavedSearches,
  matchOpenSlotsForPerformer,
  staleOpenSlots,
  outboxLagMs,
  reconcileMoney,
  snapshotNightFacts,
} from "@gigit/db";

if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN });

const TIMER_QUEUE = "booking-timers";
const REMINDER_QUEUE = "booking-reminders";
const NIGHT_FACTS_QUEUE = "venue-night-facts";
type TimerJob = {
  bookingId: string;
  fire: "OFFER_EXPIRED" | "GIG_ENDED" | "AUTO_CONFIRM_ELAPSED";
};
type ReminderJob = { bookingId: string };

const jobToEvent: Record<
  "offer_expiry" | "gig_ended" | "auto_confirm",
  TimerJob["fire"]
> = {
  offer_expiry: "OFFER_EXPIRED",
  gig_ended: "GIG_ENDED",
  auto_confirm: "AUTO_CONFIRM_ELAPSED",
};

let stopping = false;

async function main() {
  const boss = new PgBoss(env().DATABASE_URL);
  boss.on("error", (err) => log("pgboss.error", { err: String(err) }));
  await boss.start();
  await boss.createQueue(TIMER_QUEUE);

  await boss.work<TimerJob>(TIMER_QUEUE, async ([job]) => {
    if (!job) return;
    await fireTimer(job.data);
  });

  // Day-before reminder (PRD F5.2 critical path): fires only if still booked.
  await boss.createQueue(REMINDER_QUEUE);
  await boss.work<ReminderJob>(REMINDER_QUEUE, async ([job]) => {
    if (!job) return;
    const { rows } = await getPool().query(
      `select state from bookings where id = $1`,
      [job.data.bookingId],
    );
    if (rows[0]?.state !== "confirmed") {
      log("reminder.stale", { bookingId: job.data.bookingId });
      return;
    }
    await notifyBookingParties(job.data.bookingId, "day_before", "both");
    log("reminder.sent", { bookingId: job.data.bookingId });
  });

  // Nightly venue-night-facts snapshot (PRD F8.5-P0): baseline data the Phase 2
  // ROI loop joins against. Runs at 04:10 UTC; also once at boot (idempotent)
  // so gaps from worker downtime self-heal for yesterday.
  await boss.createQueue(NIGHT_FACTS_QUEUE);
  await boss.schedule(NIGHT_FACTS_QUEUE, "10 4 * * *");
  await boss.work(NIGHT_FACTS_QUEUE, async () => {
    const inserted = await snapshotNightFacts();
    log("nightfacts.snapshot", { inserted });
  });
  void snapshotNightFacts()
    .then((inserted) => log("nightfacts.snapshot", { inserted, at: "boot" }))
    .catch((err) => log("nightfacts.error", { err: String(err) }));

  // Daily series sweep (PRD F2.2): keep every active series at full horizon
  // as occurrences pass. Also at boot so dev environments stay topped up.
  const SERIES_QUEUE = "series-materialize";
  await boss.createQueue(SERIES_QUEUE);
  await boss.schedule(SERIES_QUEUE, "20 4 * * *");
  await boss.work(SERIES_QUEUE, async () => {
    const created = await materializeAllActiveSeries();
    log("series.materialized", { created });
  });
  void materializeAllActiveSeries()
    .then((created) => log("series.materialized", { created, at: "boot" }))
    .catch((err) => log("series.error", { err: String(err) }));

  // Nightly money reconciliation (spec §5 invariants): mismatches page.
  const RECONCILE_QUEUE = "reconcile-money";
  await boss.createQueue(RECONCILE_QUEUE);
  await boss.schedule(RECONCILE_QUEUE, "30 4 * * *");
  await boss.work(RECONCILE_QUEUE, async () => {
    const mismatches = await reconcileMoney();
    if (mismatches.length > 0) {
      log("reconcile.MISMATCH", { count: mismatches.length, mismatches });
      Sentry.captureMessage(`money reconciliation: ${mismatches.length} mismatches`, "error");
    } else {
      log("reconcile.clean", {});
    }
  });

  // Weekly embed-rot recheck (engineering-spec §8), Mondays 05:00 UTC.
  const EMBED_QUEUE = "embed-recheck";
  await boss.createQueue(EMBED_QUEUE);
  await boss.schedule(EMBED_QUEUE, "0 5 * * 1");
  await boss.work(EMBED_QUEUE, async () => {
    const dead = await recheckEmbeds();
    log("embeds.rechecked", { dead });
  });

  // Daily re-engagement nudge (PRD F2.3, anti-leakage): a slot still open and
  // unfilled 48h after posting pulls the venue back to the feed — once per slot
  // (a `slot.reengaged` marker dedups). The feed is the moat with payments off.
  const REENGAGE_QUEUE = "reengage-slots";
  await boss.createQueue(REENGAGE_QUEUE);
  await boss.schedule(REENGAGE_QUEUE, "0 16 * * *"); // daily 16:00 UTC
  await boss.work(REENGAGE_QUEUE, async () => {
    const stale = await staleOpenSlots();
    for (const s of stale) {
      await notifyUser(s.ownerUserId, "slot_quiet");
      await appendEvent(db(), {
        actor: "system",
        kind: "slot.reengaged",
        subjectType: "slot",
        subjectId: s.slotId,
      });
    }
    if (stale.length > 0) log("reengage.nudged", { count: stale.length });
  });

  void outboxLoop(boss);
  void reconcileLoop(boss);

  const shutdown = async () => {
    stopping = true;
    await boss.stop({ graceful: true });
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log("worker.started", {});
}

/** Apply a timer event; stale timers (state moved on) are expected no-ops. */
async function fireTimer(data: TimerJob) {
  try {
    const r = await runBookingTransition(
      data.bookingId,
      { kind: data.fire } as BookingEvent,
      "worker",
    );
    log("timer.fired", { bookingId: data.bookingId, fire: data.fire, to: r.to });
  } catch (err) {
    if (err instanceof IllegalTransitionError || err instanceof BookingNotFoundError) {
      log("timer.stale", { bookingId: data.bookingId, fire: data.fire });
      return; // idempotent no-op
    }
    throw err;
  }
}

/** Outbox: claim a batch, interpret, mark dispatched — at-least-once. */
async function outboxLoop(boss: PgBoss) {
  const pool = getPool();
  while (!stopping) {
    try {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query(
          `select id, actor, kind, subject_type, subject_id, payload
             from events
            where dispatched_at is null
            order by id
            limit 50
            for update skip locked`,
        );
        for (const row of rows) {
          await dispatchEvent(boss, row);
        }
        if (rows.length > 0) {
          await client.query(
            `update events set dispatched_at = now() where id = any($1::bigint[])`,
            [rows.map((r) => r.id)],
          );
        }
        await client.query("commit");
        if (rows.length === 0) await sleep(1000);
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      log("outbox.error", { err: String(err) });
      await sleep(5000);
    }
  }
}

async function dispatchEvent(
  boss: PgBoss,
  row: {
    id: string;
    actor: string;
    kind: string;
    subject_type: string;
    subject_id: string;
    payload: { effects?: Effect[] };
  },
) {
  const effects = row.payload?.effects ?? [];
  for (const fx of effects) {
    switch (fx.kind) {
      case "schedule": {
        await boss.send(
          TIMER_QUEUE,
          { bookingId: row.subject_id, fire: jobToEvent[fx.job] },
          {
            startAfter: new Date(fx.runAt),
            singletonKey: `${row.subject_id}:${fx.job}`,
            retryLimit: 5,
            retryBackoff: true,
          },
        );
        break;
      }
      case "cancel_schedule":
        // Timers are idempotent no-ops when stale; explicit cancellation unnecessary.
        break;
      case "request_payment": {
        const result = await paymentGateway().charge(row.subject_id);
        log("payment.charge", { booking: row.subject_id, ...result });
        if (result.status === "succeeded")
          await fireBookingEvent(row.subject_id, { kind: "PAYMENT_SUCCEEDED" });
        else if (result.status === "failed")
          await fireBookingEvent(row.subject_id, {
            kind: "PAYMENT_FAILED",
            reason: result.paymentRef,
          });
        // pending → the Stripe webhook (web service) delivers the outcome
        break;
      }
      case "notify":
        if (row.subject_type === "booking")
          await notifyBookingParties(row.subject_id, fx.template, fx.to);
        else if (row.subject_type === "tech_subslot")
          await notifySubslotParties(
            row.subject_id,
            fx.template,
            fx.to as "payer" | "tech" | "both",
          );
        else if (row.actor.startsWith("usr_"))
          // non-booking notifications (messages, applications) reach the
          // counterparty via thread participants in M2; log for now
          log("notify", { to: fx.to, template: fx.template, subject: row.subject_id });
        break;
      case "release_funds":
        await paymentGateway().transfer(row.subject_id, fx.amountCents);
        log("payment.release", { booking: row.subject_id, amount: fx.amountCents });
        break;
      case "refund_funds":
        await paymentGateway().refund(row.subject_id, fx.amountCents);
        log("payment.refund", { booking: row.subject_id, amount: fx.amountCents });
        break;
      case "cancellation_fee":
        if (fx.feeCents > 0) await paymentGateway().transfer(row.subject_id, fx.feeCents);
        if (fx.refundCents > 0)
          await paymentGateway().refund(row.subject_id, fx.refundCents);
        log("payment.cancellation_fee", { booking: row.subject_id, ...fx });
        break;
      case "reopen_slot":
      case "reliability_strike":
        break; // already applied in-transaction by the transition runner
    }
  }

  // Media trust pipeline (PRD F7.5): the screen is the only path to `ready`.
  if (row.kind === "media.screen_requested") {
    await screenMedia(row.subject_id);
  }

  // Saved-search alerts (PRD F2.3): a new open slot fans out to every
  // performer whose standing filter it matches. At-least-once like the rest
  // of the outbox; a duplicate notification beats a missed gig.
  if (row.kind === "slot.created") {
    const userIds = await matchSavedSearches(row.subject_id);
    for (const userId of userIds)
      await notifyUser(userId, "slot_match", { slotId: row.subject_id });
    if (userIds.length > 0)
      log("alerts.slot_match", { slot: row.subject_id, notified: userIds.length });
  }

  // New-act alerts (PRD F2.4, anti-leakage): a new performer fans out to every
  // venue with an open slot it fits — the "next new act" half of the feed moat,
  // the symmetric counterpart to slot_match. At-least-once; dedup not needed
  // (one event per new performer, distinct venue owners).
  if (row.kind === "performer.created") {
    const userIds = await matchOpenSlotsForPerformer(row.subject_id);
    for (const userId of userIds)
      await notifyUser(userId, "new_act", { performerId: row.subject_id });
    if (userIds.length > 0)
      log("alerts.new_act", { performer: row.subject_id, notified: userIds.length });
  }

  // Parent booking outcomes cascade into tech sub-slots (PRD F6.2): release
  // pays the tech; cancellation applies the same fee schedule.
  if (row.kind === "booking.transition") {
    const to = (row.payload as { to?: string }).to;
    if (to === "released")
      await cascadeParentToSubslots(row.subject_id, "released", "worker");
    else if (to === "cancelled_by_venue" || to === "cancelled_by_performer")
      await cascadeParentToSubslots(row.subject_id, "cancelled", "worker");
  }

  // Entering `confirmed` arms the day-before reminder (not a state transition,
  // so it lives here in the fan-out, not in the domain reducer).
  if (
    row.kind === "booking.transition" &&
    (row.payload as { to?: string }).to === "confirmed"
  ) {
    const { rows } = await getPool().query(
      `select terms->>'startsAt' as starts_at from bookings where id = $1`,
      [row.subject_id],
    );
    const startsAt = rows[0] ? new Date(rows[0].starts_at).getTime() : 0;
    const remindAt = startsAt - 24 * 3_600_000;
    if (remindAt > Date.now()) {
      await boss.send(
        REMINDER_QUEUE,
        { bookingId: row.subject_id },
        {
          startAfter: new Date(remindAt),
          singletonKey: `${row.subject_id}:day_before`,
          retryLimit: 5,
          retryBackoff: true,
        },
      );
    }
  }
}

async function fireBookingEvent(bookingId: string, event: BookingEvent) {
  try {
    await runBookingTransition(bookingId, event, "worker");
  } catch (err) {
    if (err instanceof IllegalTransitionError) return;
    throw err;
  }
}

/** Re-arm timers derivable from state; safety net for lost jobs. */
async function reconcileLoop(boss: PgBoss) {
  const pool = getPool();
  while (!stopping) {
    try {
      const { rows } = await pool.query(
        `select id, state, offer_expires_at, terms from bookings
          where state in ('offered','confirmed','awaiting_confirmation')`,
      );
      const now = Date.now();
      for (const b of rows) {
        const endsAt = new Date(b.terms.endsAt).getTime();
        let due: TimerJob | undefined;
        if (b.state === "offered" && new Date(b.offer_expires_at).getTime() <= now)
          due = { bookingId: b.id, fire: "OFFER_EXPIRED" };
        else if (b.state === "confirmed" && endsAt <= now)
          due = { bookingId: b.id, fire: "GIG_ENDED" };
        else if (b.state === "awaiting_confirmation" && endsAt + 24 * 3_600_000 <= now)
          due = { bookingId: b.id, fire: "AUTO_CONFIRM_ELAPSED" };
        if (due) await fireTimer(due);
      }
    } catch (err) {
      log("reconcile.error", { err: String(err) });
    }
    // Outbox health: undispatched events older than 5 min mean the fan-out
    // is wedged — that's a page, not a curiosity.
    try {
      const lag = await outboxLagMs();
      if (lag > 5 * 60_000) {
        log("outbox.LAGGING", { lagMs: lag });
        Sentry.captureMessage(`outbox lag ${Math.round(lag / 1000)}s`, "error");
      }
    } catch {
      /* health check must never kill the loop */
    }
    await sleep(10 * 60 * 1000);
  }
  void boss; // boss reserved for future reconcile-time re-arming of far-future timers
}

function log(kind: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...data }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
