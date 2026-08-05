import { readFile } from "node:fs/promises";
import {
  ACTIVE_SUBSLOT_STATES,
  SLOT_HOLDING_BOOKING_STATES,
} from "@gigit/domain";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getPool } from "./client.js";

const migrations = new URL("../migrations/", import.meta.url);
let schemaSequence = 0;

async function inIsolatedSchema(
  run: (
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<void>,
) {
  const client = await getPool().connect();
  const schemaName = `migration_regression_${Date.now()}_${schemaSequence++}`;
  try {
    await client.query("begin");
    await client.query(`create schema "${schemaName}"`);
    await client.query(`set local search_path to "${schemaName}"`);
    await run((sql) => client.query(sql));
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("legacy-data migrations", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("keeps the active-slot partial index aligned with the domain holding set", async () => {
    const source = await readFile(new URL("schema.ts", import.meta.url), "utf8");
    const predicate = source.match(
      /uniqueIndex\("bookings_active_slot_uq"\)[\s\S]*?sql`state in \(([^`]+)\)`/,
    )?.[1];
    expect(predicate).toBeTruthy();
    const indexedStates = [
      ...(predicate?.matchAll(/'([a-z_]+)'/g) ?? []),
    ].map((match) => match[1]);
    expect(indexedStates).toEqual(SLOT_HOLDING_BOOKING_STATES);
  });

  it("keeps the active-sound-job partial index aligned with the domain active set", async () => {
    const source = await readFile(new URL("schema.ts", import.meta.url), "utf8");
    const predicate = source.match(
      /uniqueIndex\("tech_subslots_active_booking_uq"\)[\s\S]*?sql`state in \(([^`]+)\)`/,
    )?.[1];
    expect(predicate).toBeTruthy();
    const indexedStates = [
      ...(predicate?.matchAll(/'([a-z_]+)'/g) ?? []),
    ].map((match) => match[1]);
    expect(indexedStates).toEqual(ACTIVE_SUBSLOT_STATES);
  });

  it("clamps the old 500 km maximum to the valid 300-mile maximum", async () => {
    await inIsolatedSchema(async (query) => {
      await query(`
        create table performers (
          id text primary key,
          travel_radius_km integer not null default 50
        );
        create table techs (
          id text primary key,
          travel_radius_km integer not null default 50
        );
        insert into performers values ('local', 0), ('tiny', 1), ('maximum', 500);
        insert into techs values ('local', 0), ('tiny', 1), ('maximum', 500);
      `);
      await query(
        await readFile(new URL("0026_travel_radius_miles.sql", migrations), "utf8"),
      );

      for (const table of ["performers", "techs"]) {
        const { rows } = await query(
          `select id, travel_radius_miles from ${table} order by id`,
        );
        expect(rows).toEqual([
          { id: "local", travel_radius_miles: 0 },
          { id: "maximum", travel_radius_miles: 300 },
          { id: "tiny", travel_radius_miles: 1 },
        ]);
        const inserted = `${table}-default`;
        await query(`insert into ${table} (id) values ('${inserted}')`);
        const defaults = await query(
          `select travel_radius_miles from ${table} where id = '${inserted}'`,
        );
        expect(defaults.rows[0]).toEqual({ travel_radius_miles: 30 });
      }
    });
  });

  it("forward-clamps databases that already stored the original 311-mile conversion", async () => {
    await inIsolatedSchema(async (query) => {
      await query(`
        create table performers (
          id text primary key,
          travel_radius_miles integer not null
        );
        create table techs (
          id text primary key,
          travel_radius_miles integer not null
        );
        insert into performers values ('legacy', 311), ('limit', 300), ('local', 0);
        insert into techs values ('legacy', 311), ('limit', 300), ('local', 0);
      `);
      await query(
        await readFile(new URL("0029_travel_radius_clamp.sql", migrations), "utf8"),
      );

      for (const table of ["performers", "techs"]) {
        const { rows } = await query(
          `select id, travel_radius_miles from ${table} order by id`,
        );
        expect(rows).toEqual([
          { id: "legacy", travel_radius_miles: 300 },
          { id: "limit", travel_radius_miles: 300 },
          { id: "local", travel_radius_miles: 0 },
        ]);
      }
    });
  });

  it("deduplicates live profiles deterministically before adding owner indexes", async () => {
    await inIsolatedSchema(async (query) => {
      for (const table of ["performers", "venues", "techs"])
        await query(`
          create table ${table} (
            id text primary key,
            owner_user_id text not null,
            status text not null,
            created_at timestamptz not null
          )
        `);

      for (const table of ["performers", "venues", "techs"])
        await query(`
          insert into ${table} values
            ('canonical', 'owner-1', 'live', '2026-01-01T00:00:00Z'),
            ('same-time-later-id', 'owner-1', 'live', '2026-01-01T00:00:00Z'),
            ('newer', 'owner-1', 'live', '2026-02-01T00:00:00Z'),
            ('already-hidden', 'owner-1', 'hidden', '2025-01-01T00:00:00Z'),
            ('other-owner', 'owner-2', 'live', '2026-03-01T00:00:00Z')
        `);

      await query(
        await readFile(new URL("0027_profile_uniqueness.sql", migrations), "utf8"),
      );

      for (const table of ["performers", "venues", "techs"]) {
        const { rows } = await query(
          `select id, status from ${table} order by id`,
        );
        expect(rows).toEqual([
          { id: "already-hidden", status: "hidden" },
          { id: "canonical", status: "live" },
          { id: "newer", status: "hidden" },
          { id: "other-owner", status: "live" },
          { id: "same-time-later-id", status: "hidden" },
        ]);
      }

      const { rows: indexes } = await query(`
        select indexname
          from pg_indexes
         where schemaname = current_schema()
         order by indexname
      `);
      expect(indexes.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "performers_owner_uq",
          "venues_owner_uq",
          "techs_owner_uq",
        ]),
      );
    });
  });

  it("merges legacy duplicate booking threads before adding the scoped index", async () => {
    await inIsolatedSchema(async (query) => {
      await query(`
        create table threads (
          id text primary key,
          scope text not null,
          subject_id text,
          created_at timestamptz not null
        );
        create table thread_participants (
          thread_id text not null references threads(id),
          user_id text not null,
          unique (thread_id, user_id)
        );
        create table messages (
          id text primary key,
          thread_id text not null references threads(id)
        );
        create table events (
          id text primary key,
          subject_type text not null,
          subject_id text not null
        );
        insert into threads values
          ('booking-a', 'booking', 'booking-1', '2026-01-01T00:00:00Z'),
          ('booking-b', 'booking', 'booking-1', '2026-02-01T00:00:00Z'),
          ('inquiry-a', 'inquiry', 'slot-1', '2026-01-01T00:00:00Z'),
          ('inquiry-b', 'inquiry', 'slot-1', '2026-02-01T00:00:00Z');
        insert into thread_participants values
          ('booking-a', 'venue-user'),
          ('booking-b', 'venue-user'),
          ('booking-b', 'act-user');
        insert into messages values
          ('message-a', 'booking-a'),
          ('message-b', 'booking-b');
        insert into events values
          ('event-thread', 'thread', 'booking-b'),
          ('event-other-subject', 'booking', 'booking-b');
      `);

      await query(
        await readFile(
          new URL("0028_booking_thread_uniqueness.sql", migrations),
          "utf8",
        ),
      );

      const { rows: threads } = await query(
        "select id from threads order by id",
      );
      expect(threads).toEqual([
        { id: "booking-a" },
        { id: "inquiry-a" },
        { id: "inquiry-b" },
      ]);
      const { rows: participants } = await query(
        "select thread_id, user_id from thread_participants order by user_id",
      );
      expect(participants).toEqual([
        { thread_id: "booking-a", user_id: "act-user" },
        { thread_id: "booking-a", user_id: "venue-user" },
      ]);
      const { rows: messages } = await query(
        "select id, thread_id from messages order by id",
      );
      expect(messages).toEqual([
        { id: "message-a", thread_id: "booking-a" },
        { id: "message-b", thread_id: "booking-a" },
      ]);
      const { rows: events } = await query(
        "select id, subject_id from events order by id",
      );
      expect(events).toEqual([
        { id: "event-other-subject", subject_id: "booking-b" },
        { id: "event-thread", subject_id: "booking-a" },
      ]);
      const { rows: indexes } = await query(`
        select indexname from pg_indexes
         where schemaname = current_schema()
           and indexname = 'threads_booking_subject_uq'
      `);
      expect(indexes).toHaveLength(1);
    });
  });

  it("safely closes only duplicate open sound jobs before adding the unique index", async () => {
    await inIsolatedSchema(async (query) => {
      await query(`
        create table tech_subslots (
          id text primary key,
          booking_id text not null,
          state text not null,
          version integer not null default 1,
          created_at timestamptz not null
        );
        create table tech_subslot_applications (
          id text primary key,
          subslot_id text not null references tech_subslots(id),
          status text not null
        );
        insert into tech_subslots values
          ('booked-old', 'booking-1', 'booked', 4, '2026-01-02T00:00:00Z'),
          ('open-older', 'booking-1', 'open', 7, '2026-01-01T00:00:00Z'),
          ('open-a', 'booking-2', 'open', 1, '2026-03-01T00:00:00Z'),
          ('open-b', 'booking-2', 'open', 1, '2026-03-01T00:00:00Z'),
          ('history', 'booking-1', 'released', 9, '2025-01-01T00:00:00Z');
        insert into tech_subslot_applications values
          ('kept-app', 'booked-old', 'submitted'),
          ('closed-open-app', 'open-older', 'submitted'),
          ('open-a-app', 'open-a', 'submitted'),
          ('open-b-app', 'open-b', 'submitted');
      `);

      await query(
        await readFile(
          new URL("0030_active_tech_subslot_unique.sql", migrations),
          "utf8",
        ),
      );

      const { rows: subslots } = await query(`
        select id, state, version
          from tech_subslots
         order by id
      `);
      expect(subslots).toEqual([
        { id: "booked-old", state: "booked", version: 4 },
        { id: "history", state: "released", version: 9 },
        { id: "open-a", state: "open", version: 1 },
        { id: "open-b", state: "cancelled_by_payer", version: 2 },
        { id: "open-older", state: "cancelled_by_payer", version: 8 },
      ]);
      const { rows: applications } = await query(`
        select id, status
          from tech_subslot_applications
         order by id
      `);
      expect(applications).toEqual([
        { id: "closed-open-app", status: "declined" },
        { id: "kept-app", status: "submitted" },
        { id: "open-a-app", status: "submitted" },
        { id: "open-b-app", status: "declined" },
      ]);

      await query("savepoint duplicate_active_sound_job");
      await expect(
        query(`
          insert into tech_subslots
            (id, booking_id, state, version, created_at)
          values ('duplicate', 'booking-1', 'open', 1, now())
        `),
      ).rejects.toMatchObject({ code: "23505" });
      await query("rollback to savepoint duplicate_active_sound_job");
      await query(`
        insert into tech_subslots
          (id, booking_id, state, version, created_at)
        values ('more-history', 'booking-1', 'released', 1, now())
      `);
    });
  });

  it("fails loudly instead of inventing outcomes for multiple booked sound jobs", async () => {
    await inIsolatedSchema(async (query) => {
      await query(`
        create table tech_subslots (
          id text primary key,
          booking_id text not null,
          state text not null,
          version integer not null default 1,
          created_at timestamptz not null
        );
        create table tech_subslot_applications (
          id text primary key,
          subslot_id text not null references tech_subslots(id),
          status text not null
        );
        insert into tech_subslots values
          ('booked-a', 'booking-needs-review', 'booked', 2, '2026-01-01T00:00:00Z'),
          ('booked-b', 'booking-needs-review', 'booked', 3, '2026-02-01T00:00:00Z');
      `);

      await expect(
        query(
          await readFile(
            new URL("0030_active_tech_subslot_unique.sql", migrations),
            "utf8",
          ),
        ),
      ).rejects.toThrow(
        /multiple booked sound jobs require manual remediation.*booking-needs-review/,
      );
    });
  });
});
