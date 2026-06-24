import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { drainOutboxOnce } from "./index.js";

/**
 * The poison-event regression (audit #3): one throwing event must not roll back
 * the others or wedge the head forever. These synthetic events never reach the
 * `boss` branches (no schedule/booking.transition), so a stub boss is fine.
 */
const noBoss = {} as unknown as PgBoss;

describe("outbox poison isolation (integration)", () => {
  let goodId: number;
  let poisonId: number;
  let goodAfterId: number;

  beforeAll(async () => {
    const pool = getPool();
    // Reason only about this test's two events: clear any prior backlog.
    await pool.query(
      `update events set dispatched_at = now() where dispatched_at is null and dead_lettered_at is null`,
    );
    const good = await pool.query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('system','test.noop','test','t','{"effects":[]}'::jsonb) returning id`,
    );
    goodId = Number(good.rows[0].id);
    // payload.effects is not an array → dispatchEvent's `for..of` throws every time.
    const poison = await pool.query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('system','test.poison','test','t','{"effects":5}'::jsonb) returning id`,
    );
    poisonId = Number(poison.rows[0].id);
    // a good event ordered AFTER the poison: it must still dispatch in the same
    // drain, proving the loop continues past a throwing row (not just before it).
    const goodAfter = await pool.query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('system','test.noop','test','t','{"effects":[]}'::jsonb) returning id`,
    );
    goodAfterId = Number(goodAfter.rows[0].id);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("dispatches the good event and isolates the poison (no wedge, good not rolled back)", async () => {
    await drainOutboxOnce(noBoss);

    const [g] = await db().select().from(schema.events).where(eq(schema.events.id, goodId));
    expect(g!.dispatchedAt).not.toBeNull();

    const [p] = await db().select().from(schema.events).where(eq(schema.events.id, poisonId));
    expect(p!.dispatchedAt).toBeNull();
    expect(p!.attempts).toBe(1);
    expect(p!.deadLetteredAt).toBeNull();

    // the good event AFTER the poison also dispatched — the loop didn't abort
    const [g2] = await db().select().from(schema.events).where(eq(schema.events.id, goodAfterId));
    expect(g2!.dispatchedAt).not.toBeNull();
  });

  it("parks the poison after the attempt cap, then excludes it so the head advances", async () => {
    // one attempt already; drain to the cap of 5
    for (let i = 0; i < 4; i++) await drainOutboxOnce(noBoss);

    const [p] = await db().select().from(schema.events).where(eq(schema.events.id, poisonId));
    expect(p!.attempts).toBe(5);
    expect(p!.deadLetteredAt).not.toBeNull();
    expect(p!.lastError).toContain("iterable");

    // parked → excluded from the claim, so a further drain doesn't touch it again
    await drainOutboxOnce(noBoss);
    const [p2] = await db().select().from(schema.events).where(eq(schema.events.id, poisonId));
    expect(p2!.attempts).toBe(5);
  });
});
