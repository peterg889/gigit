import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";

/**
 * Boot coverage for the worker (journeys O2/O4/O5/O17-O19).
 *
 * Everything in `main()` was reachable from no test: the suite imported
 * `drainOutboxOnce` and `reconcileOnce` and nothing else, so the queue names,
 * the six cron strings and the three fire-and-forget boot self-heals never ran.
 * A cron typo turns a nightly job into one that never fires, with no error
 * anywhere — the job simply stops existing and the first sign is missing data.
 *
 * The most expensive of those is `snapshotNightFacts`: venue-night facts are
 * derived from bookings *as they were that night* and are explicitly
 * unbackfillable, which is the entire reason a boot call exists alongside the
 * 04:10 schedule. A worker that was down over midnight has exactly one chance
 * to heal the gap, and it takes it here.
 *
 * `main()` is exported and called directly rather than letting the module's own
 * `if (!process.env.VITEST)` boot fire: that guard exists so importing this file
 * doesn't start a worker, and deleting `VITEST` from the environment to defeat
 * it would also arm the `process.exit(1)` in its `.catch`.
 */

// pg-boss is faked wholesale: this file is about WHICH queues/crons/handlers get
// registered, and a real boss would build its own schema and start polling.
const boss = vi.hoisted(() => ({
  started: 0,
  stopped: 0,
  queues: [] as string[],
  workers: [] as string[],
  schedules: [] as { queue: string; cron: string }[],
}));
vi.mock("pg-boss", () => {
  class FakePgBoss {
    on() {}
    async start() {
      boss.started++;
    }
    async createQueue(name: string) {
      boss.queues.push(name);
    }
    async work(name: string) {
      boss.workers.push(name);
    }
    async schedule(name: string, cron: string) {
      boss.schedules.push({ queue: name, cron });
    }
    async stop() {
      boss.stopped++;
    }
  }
  return { default: FakePgBoss };
});

const nightFactsCalls = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    // Counted, but DELEGATING to the real implementation — the point of the
    // assertion below is which night the real SQL picks when boot passes no
    // argument, so a stub returning a number would prove nothing.
    snapshotNightFacts: async (nightDate?: string) => {
      nightFactsCalls.push(nightDate);
      return actual.snapshotNightFacts(nightDate);
    },
    // The other two boot self-heals sweep rows this file did not create (every
    // active series, every past-dated open slot). They are covered in
    // packages/db; here they would only mutate other suites' fixtures.
    materializeAllActiveSeries: async () => 0,
    expirePastSlots: async () => 0,
  };
});

const { closeDb, db, getPool, schema } = await import("@gigit/db");
const { main } = await import("./index.js");

const yesterday = () =>
  new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/** Poll until `check` passes; fails the test rather than hanging forever. */
async function until(what: string, check: () => Promise<boolean>, ms = 4_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("worker boot", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  let markerId: number;

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values({ id: userId, email: `${userId}@t.test` });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "bar",
      name: "Boot Bar",
      metro: "boot-tv",
      lat: 43,
      lng: -88,
      addressLine1: "1 Boot St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });

    // Boot starts a real drain loop against the shared database. Retire any
    // backlog first (as outbox.test.ts does) so the loop can only touch this
    // file's own marker and cannot fire another suite's effects.
    const pool = getPool();
    await pool.query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
    const marker = await pool.query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('system','test.noop','test',$1,'{"effects":[]}'::jsonb) returning id`,
      [venueId],
    );
    markerId = Number(marker.rows[0].id);

    await main();
  });

  afterAll(async () => {
    // main() installs the real SIGTERM shutdown; use it (that is the only way to
    // set `stopping` and unwind the loops) with process.exit stubbed out.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    exit.mockRestore();
    await closeDb();
  });

  it("registers every queue it schedules and works every queue it registers", () => {
    expect(boss.started).toBe(1);
    // A queue that is scheduled but never created, or worked but never created,
    // is a job that silently does nothing forever. Neither shows up as an error.
    expect([...new Set(boss.schedules.map((s) => s.queue))].sort()).toEqual(
      boss.queues.filter((q) => boss.schedules.some((s) => s.queue === q)).sort(),
    );
    expect(boss.workers.sort()).toEqual([...boss.queues].sort());
    expect([...boss.queues].sort()).toEqual(
      [
        "booking-reminders",
        "booking-timers",
        "embed-recheck",
        "expire-slots",
        "reconcile-money",
        "reengage-slots",
        "review-prompts",
        "series-materialize",
        "venue-night-facts",
      ].sort(),
    );
  });

  it("schedules each nightly job at its documented UTC time", () => {
    // Pinned because a one-character edit here is undetectable at runtime: the
    // job just never fires again. All times UTC (the stack runs the worker in
    // UTC), and the map is exact so an added or dropped schedule fails too.
    expect(Object.fromEntries(boss.schedules.map((s) => [s.queue, s.cron]))).toEqual({
      "venue-night-facts": "10 4 * * *", // 04:10 — unbackfillable ROI baseline
      "series-materialize": "20 4 * * *", // 04:20 — keep series at full horizon
      "reconcile-money": "30 4 * * *", // 04:30 — the nightly ledger check that pages
      "embed-recheck": "0 5 * * 1", // Mondays 05:00 — weekly embed-rot sweep
      "reengage-slots": "0 16 * * *", // 16:00 — anti-leakage nudge
      "expire-slots": "5 * * * *", // hourly at :05 — age out past open nights
    });
    expect(boss.schedules).toHaveLength(6);
  });

  it("snapshots venue-night facts for YESTERDAY, exactly once, at boot", async () => {
    // The boot call is deliberately un-awaited (`void snapshotNightFacts()`), so
    // wait for its write rather than for main() to return.
    const nights = async () =>
      (
        await getPool().query(
          `select night_date::text as night from venue_night_facts where venue_id = $1`,
          [venueId],
        )
      ).rows.map((r) => r.night as string);
    await until("the boot night-facts snapshot to land", async () =>
      (await nights()).length > 0,
    );

    // `undefined` has to mean yesterday. Tonight is not over: snapshotting today
    // would record "no booking" for venues that are mid-gig, and the row is
    // idempotent on (venue, night), so that wrong answer is the permanent one.
    expect(await nights()).toEqual([yesterday()]);
    expect(await nights()).not.toContain(today());

    // Exactly once: the boot call and the 04:10 handler both exist, and a second
    // boot call is a full-table pass over every venue on every restart.
    expect(nightFactsCalls).toEqual([undefined]);
  });

  it("reaches the outbox drain loop", async () => {
    // The loops are started with bare `void` calls at the end of main(); if
    // anything above them throws or never resolves, the worker boots, logs
    // nothing unusual, and dispatches no events for the rest of its life.
    await until("the boot marker event to be dispatched", async () => {
      const { rows } = await getPool().query(
        `select dispatched_at from events where id = $1`,
        [markerId],
      );
      return rows[0]?.dispatched_at != null;
    });
  });
});
