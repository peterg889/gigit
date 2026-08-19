import { closeDb, db, getPool, makeUser, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const PROFILE_EXISTS_MESSAGE =
  "You already have an act profile — edit it from your profile page.";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/performers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * Wait until `count` backends on this database are blocked on a lock. Used to
 * prove two in-flight requests are both parked inside their transactions before
 * the gate that holds them is released.
 */
async function waitForBlockedBackends(count: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await getPool().query<{ blocked: string }>(
      `select count(*)::text as blocked from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]!.blocked) >= count) return;
    if (Date.now() > deadline)
      throw new Error(`only ${rows[0]!.blocked} backend(s) blocked, wanted ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The minimum an act types into the signup form; overridden per test. */
const actBody = (overrides: Record<string, unknown> = {}) => ({
  kind: "band",
  name: "Concurrent Act",
  homeMetro: "milwaukee",
  ...overrides,
});

/**
 * Creating an act — the demand side's front door, and until now a route no test
 * file imported at all.
 *
 * Two things are load-bearing here beyond "a row appears". The first is the
 * `performer.created` event: deleting the appendEvent call inside the
 * transaction silences `act_welcome` (the only day-one message an act ever
 * receives) and the `new_act` fan-out that tells venues someone new is playing,
 * and nothing else in the suite would notice. The second is that the event is
 * appended in the SAME transaction as the insert, so a half-created act — a
 * profile nobody was told about — cannot survive a failed append.
 *
 * The sound-tech equivalent (../techs/route.test.ts) counts rows and never reads
 * one, so a route that persisted the right NUMBER of wrong rows passed there.
 * The full-row test below is deliberately not that.
 */
describe("act profile creation", () => {
  let concurrentOwnerId: string;
  let rollbackOwnerId: string;
  let valuesOwnerId: string;

  beforeAll(async () => {
    concurrentOwnerId = await makeUser({ email: `${Date.now()}-a@act-create.test` });
    rollbackOwnerId = await makeUser({ email: `${Date.now()}-b@act-create.test` });
    valuesOwnerId = await makeUser({ email: `${Date.now()}-c@act-create.test` });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns one created act and one clean conflict for a double submit", async () => {
    sessionUserId.mockResolvedValue(concurrentOwnerId);
    // The double-click, fired together. In practice the second request's
    // `performerOwnedBy` preflight is what answers here; the test below forces
    // the other, harder branch where both requests get past the preflight.
    const responses = await Promise.all([
      post(actBody({ name: "Concurrent Act A" })),
      post(actBody({ name: "Concurrent Act B" })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const conflict = responses.find((response) => response.status === 409)!;
    // The exact copy, because this string is the entire explanation the act gets
    // for why their second submit did nothing.
    expect(await conflict.json()).toEqual({
      error: { code: "conflict", message: PROFILE_EXISTS_MESSAGE },
    });

    const profiles = await db()
      .select({ id: schema.performers.id, name: schema.performers.name })
      .from(schema.performers)
      .where(eq(schema.performers.ownerUserId, concurrentOwnerId));
    expect(profiles).toHaveLength(1);

    const created = responses.find((response) => response.status === 201)!;
    const body = (await created.json()) as {
      id: string;
      foundingNumber: number;
      foundingMember: boolean;
    };
    // The winner's id is the row that exists — the loser's insert left nothing
    // behind, and the 201 did not report someone else's profile.
    expect(profiles[0]!.id).toBe(body.id);

    const creationEvents = await db()
      .select({
        subjectId: schema.events.subjectId,
        subjectType: schema.events.subjectType,
        payload: schema.events.payload,
      })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, concurrentOwnerId),
          eq(schema.events.kind, "performer.created"),
        ),
      );
    // Exactly one: the losing transaction must not leave an event announcing an
    // act that does not exist, and the winner must leave exactly the one that
    // act_welcome and the new_act venue fan-out both key off.
    expect(creationEvents).toHaveLength(1);
    expect(creationEvents[0]).toMatchObject({
      subjectId: body.id,
      subjectType: "performer",
      payload: {
        foundingNumber: body.foundingNumber,
        foundingMember: body.foundingMember,
      },
    });
  });

  it("answers the loser of a true index race with the same 409, not a 500", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-race@act-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    // The preflight is a courtesy; `performers_owner_uq` is the actual boundary,
    // and it is only reached when two requests both read "no profile yet" before
    // either commits. Holding the owner's users row FOR UPDATE parks both
    // requests inside `lockActiveAccounts` — which every profile route calls as
    // its first statement in the transaction — so both are provably past their
    // preflight before either can insert. Without this, the second request's
    // preflight simply wins the timing and the 23505 mapping in
    // respondProfileCreateError is never executed: deleting it left the naive
    // double-submit test above green.
    const gate = await getPool().connect();
    let responses: Response[];
    try {
      await gate.query("begin");
      await gate.query("select id from users where id = $1 for update", [ownerId]);
      const inFlight = Promise.all([
        post(actBody({ name: "Race Act A" })),
        post(actBody({ name: "Race Act B" })),
      ]);
      try {
        await waitForBlockedBackends(2);
      } finally {
        // Release whether or not both parked, so a timeout fails on the
        // assertion below rather than hanging on an unsettled promise.
        await gate.query("commit");
      }
      responses = await inFlight;
    } finally {
      gate.release();
    }

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    // Drizzle wraps the PostgreSQL error, so an unmapped 23505 surfaces as a
    // thrown 500 — a duplicate-key stack trace shown to an act who just clicked
    // "Create profile" twice.
    expect(await conflict.json()).toEqual({
      error: { code: "conflict", message: PROFILE_EXISTS_MESSAGE },
    });
    const profiles = await db()
      .select({ id: schema.performers.id })
      .from(schema.performers)
      .where(eq(schema.performers.ownerUserId, ownerId));
    expect(profiles).toHaveLength(1);
  });

  it("rolls the act back when its creation event cannot be persisted", async () => {
    // A real `before insert on events` trigger rather than a mocked appendEvent:
    // the point is that the insert and the append share one transaction, which
    // only a failure raised by the database itself can prove.
    const suffix = rollbackOwnerId.replace(/[^a-z0-9]/gi, "").slice(-16).toLowerCase();
    const functionName = `fail_performer_event_${suffix}`;
    const triggerName = `fail_performer_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.actor = '${rollbackOwnerId}' and new.kind = 'performer.created' then
          raise exception 'forced performer event failure';
        end if;
        return new;
      end
      $$
    `);
    await pool.query(`
      create trigger ${triggerName}
      before insert on events
      for each row execute function ${functionName}()
    `);

    sessionUserId.mockResolvedValue(rollbackOwnerId);
    try {
      await expect(post(actBody({ name: "Rollback Act" }))).rejects.toThrow();
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    // Zero of both. An act whose creation event was lost is invisible to every
    // notification the platform sends, so a surviving profile row would be worse
    // than no profile at all — the act would look signed up and hear nothing.
    const profiles = await db()
      .select({ id: schema.performers.id })
      .from(schema.performers)
      .where(eq(schema.performers.ownerUserId, rollbackOwnerId));
    expect(profiles).toHaveLength(0);
    const creationEvents = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actor, rollbackOwnerId),
          eq(schema.events.kind, "performer.created"),
        ),
      );
    expect(creationEvents).toHaveLength(0);
  });

  it("persists every answer the signup form asked for", async () => {
    sessionUserId.mockResolvedValue(valuesOwnerId);
    const res = await post({
      kind: "comedian",
      name: "The Full Row",
      bio: "Two decades of one-nighters.",
      genreTags: ["standup", "improv"],
      // Mixed case and padding as a human would type a city name. The feed
      // filter and the saved-search matcher both compare against a lowercased
      // metro, so an act that typed "Milwaukee" must still be found in
      // "milwaukee".
      homeMetro: "  Milwaukee  ",
      travelRadiusMiles: 75,
      // Cents, not dollars. A route that stored 150 here would show this act as
      // playing for $1.50 and price them out of, or into, every search.
      rateMinCents: 15_000,
      rateMaxCents: 40_000,
      setLengthsMinutes: [30, 45],
      techNeeds: { inputs: 6, micsNeeded: 2, monitorsNeeded: 1, canPlayUnamplified: false },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      foundingNumber: number;
      foundingMember: boolean;
    };

    const [row] = await db()
      .select()
      .from(schema.performers)
      .where(eq(schema.performers.id, body.id));
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      ownerUserId: valuesOwnerId,
      kind: "comedian",
      name: "The Full Row",
      bio: "Two decades of one-nighters.",
      genreTags: ["standup", "improv"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 75,
      rateMinCents: 15_000,
      rateMaxCents: 40_000,
      setLengthsMinutes: [30, 45],
      techNeeds: { inputs: 6, micsNeeded: 2, monitorsNeeded: 1, canPlayUnamplified: false },
      status: "live",
    });
    // The founding rank the act was promised in the response is the rank stored
    // on the row: it has to survive to billing time, so the API answer and the
    // durable record cannot be allowed to disagree.
    expect(row!.foundingNumber).toBe(body.foundingNumber);
    expect(row!.foundingMember).toBe(body.foundingMember);
    expect(body.foundingNumber).toBeGreaterThanOrEqual(1);
  });

  it("omits rates the act left blank rather than storing zero", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-d@act-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    const res = await post(actBody({ name: "No Rates Stated" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db()
      .select()
      .from(schema.performers)
      .where(eq(schema.performers.id, id));
    // null means "hasn't said", which discovery must not read as "plays for
    // free" — a zero here would undercut every act in the market.
    expect(row!.rateMinCents).toBeNull();
    expect(row!.rateMaxCents).toBeNull();
    // Schema defaults, so a minimal signup still produces a searchable row.
    expect(row!.genreTags).toEqual([]);
    expect(row!.techNeeds).toEqual({ inputs: 0 });
    expect(row!.travelRadiusMiles).toBe(30);
  });
});
