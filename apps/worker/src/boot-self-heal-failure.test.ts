import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";

/**
 * The other half of the boot story (see boot.test.ts): what a FAILING self-heal
 * does to the worker.
 *
 * The three boot calls at the end of main() are `void`-ed with a log-only
 * `.catch`, deliberately — the worker's job is to keep draining the outbox, and
 * one broken nightly sweep must not take the whole service down with it. That
 * "deliberately" was never tested, and the failure mode it guards against is
 * total: an unhandled rejection there kills the process, ECS restarts it, the
 * self-heal fails again, and the booking platform sits in a crash loop caused by
 * an analytics table.
 *
 * A separate file from boot.test.ts because a module can only be booted once.
 */
const boss = vi.hoisted(() => ({ queues: [] as string[] }));
vi.mock("pg-boss", () => {
  class FakePgBoss {
    on() {}
    async start() {}
    async createQueue(name: string) {
      boss.queues.push(name);
    }
    async work() {}
    async schedule() {}
    async stop() {}
  }
  return { default: FakePgBoss };
});

const SELF_HEAL_FAILURE = "night facts exploded";
vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    // A rejected promise, not a callback that throws: vitest attributes an
    // error thrown by test-file code to the test even when the code under test
    // catches it, which would fail this test for the very behaviour it asserts.
    snapshotNightFacts: () => Promise.reject(new Error(SELF_HEAL_FAILURE)),
    materializeAllActiveSeries: async () => 0,
    expirePastSlots: async () => 0,
  };
});

const { closeDb, getPool } = await import("@gigit/db");
const { main } = await import("./index.js");

describe("worker boot with a failing self-heal", () => {
  const subject = newId("venue");
  let markerId: number;
  const logged: string[] = [];

  beforeAll(async () => {
    const pool = getPool();
    await pool.query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
    const marker = await pool.query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('system','test.noop','test',$1,'{"effects":[]}'::jsonb) returning id`,
      [subject],
    );
    markerId = Number(marker.rows[0].id);

    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    await main();
  });

  afterAll(async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    exit.mockRestore();
    vi.restoreAllMocks();
    await closeDb();
  });

  it("still reaches the outbox drain loop", async () => {
    const deadline = Date.now() + 4_000;
    let dispatched = false;
    while (Date.now() < deadline && !dispatched) {
      const { rows } = await getPool().query(
        `select dispatched_at from events where id = $1`,
        [markerId],
      );
      dispatched = rows[0]?.dispatched_at != null;
      if (!dispatched) await new Promise((r) => setTimeout(r, 100));
    }
    expect(dispatched).toBe(true);
  });

  it("reports the failed self-heal instead of swallowing it", () => {
    // The `.catch` is log-only, so this log line is the ONLY trace a self-heal
    // that fails on every restart leaves behind. Losing it (a bare `.catch(() =>
    // {})`, say) makes an unbackfillable gap in venue_night_facts completely
    // silent — and the data cannot be recovered later by definition.
    const errors = logged.filter((l) => l.includes("nightfacts.error"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(SELF_HEAL_FAILURE);
    // and it must NOT have claimed success
    expect(logged.filter((l) => l.includes("nightfacts.snapshot"))).toHaveLength(0);
  });
});
