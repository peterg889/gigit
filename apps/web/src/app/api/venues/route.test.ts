import { closeDb, db, getPool, makeUser, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const PROFILE_EXISTS_MESSAGE =
  "You already have a venue profile — edit it from your profile page.";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/venues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** A complete room, which is what the venue form insists on before it submits. */
const venueBody = (overrides: Record<string, unknown> = {}) => ({
  kind: "bar",
  name: "The Test Room",
  addressLine1: "1 Test St",
  city: "Milwaukee",
  region: "WI",
  postalCode: "53202",
  timeZone: "America/Chicago",
  ...overrides,
});

/** See ../performers/route.test.ts — same helper, same reason. */
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

/**
 * Creating a venue — until now executed only as a fixture helper inside
 * slots/create.test.ts, which posts one venue to get an id and never looks at
 * what was stored or at what a second submit does.
 *
 * The stakes match the act side: the `venue.created` event is what tells the
 * rest of the platform a new room exists, and it is appended in the same
 * transaction as the insert so a room nobody was told about cannot survive. On
 * top of that, this route DERIVES two things the caller never sent — the metro
 * and the search coordinates — and both are silently wrong-able.
 */
describe("venue profile creation", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("returns one created venue and one clean conflict for a double submit", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-a@venue-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    const responses = await Promise.all([
      post(venueBody({ name: "Concurrent Room A" })),
      post(venueBody({ name: "Concurrent Room B" })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toEqual({
      error: { code: "conflict", message: PROFILE_EXISTS_MESSAGE },
    });

    const created = responses.find((response) => response.status === 201)!;
    const body = (await created.json()) as {
      id: string;
      foundingNumber: number;
      foundingMember: boolean;
    };
    const profiles = await db()
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(eq(schema.venues.ownerUserId, ownerId));
    expect(profiles).toHaveLength(1);
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
          eq(schema.events.actor, ownerId),
          eq(schema.events.kind, "venue.created"),
        ),
      );
    expect(creationEvents).toHaveLength(1);
    expect(creationEvents[0]).toMatchObject({
      subjectId: body.id,
      subjectType: "venue",
      payload: {
        foundingNumber: body.foundingNumber,
        foundingMember: body.foundingMember,
      },
    });
  });

  it("answers the loser of a true index race with the same 409, not a 500", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-race@venue-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    // Holding the owner's users row parks both requests inside
    // `lockActiveAccounts`, so both are past the `venueOwnedBy` preflight before
    // either can insert and `venues_owner_uq` is the thing that decides. That is
    // the only path that executes the 23505 → 409 mapping; left to timing, the
    // preflight answers first and the mapping goes untested.
    const gate = await getPool().connect();
    let responses: Response[];
    try {
      await gate.query("begin");
      await gate.query("select id from users where id = $1 for update", [ownerId]);
      const inFlight = Promise.all([
        post(venueBody({ name: "Race Room A" })),
        post(venueBody({ name: "Race Room B" })),
      ]);
      try {
        await waitForBlockedBackends(2);
      } finally {
        await gate.query("commit");
      }
      responses = await inFlight;
    } finally {
      gate.release();
    }

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toEqual({
      error: { code: "conflict", message: PROFILE_EXISTS_MESSAGE },
    });
    const profiles = await db()
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(eq(schema.venues.ownerUserId, ownerId));
    expect(profiles).toHaveLength(1);
  });

  it("rolls the venue back when its creation event cannot be persisted", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-b@venue-create.test` });
    const suffix = ownerId.replace(/[^a-z0-9]/gi, "").slice(-16).toLowerCase();
    const functionName = `fail_venue_event_${suffix}`;
    const triggerName = `fail_venue_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.actor = '${ownerId}' and new.kind = 'venue.created' then
          raise exception 'forced venue event failure';
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

    sessionUserId.mockResolvedValue(ownerId);
    try {
      await expect(post(venueBody({ name: "Rollback Room" }))).rejects.toThrow();
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    // A venue row whose creation event never landed is a room the rest of the
    // platform was never told about; it must not outlive the failed append.
    const profiles = await db()
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(eq(schema.venues.ownerUserId, ownerId));
    expect(profiles).toHaveLength(0);
    const creationEvents = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(eq(schema.events.actor, ownerId), eq(schema.events.kind, "venue.created")),
      );
    expect(creationEvents).toHaveLength(0);
  });

  it("persists every answer, and derives the metro and search point from the city", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-c@venue-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    const res = await post({
      kind: "brewery",
      name: "The Full Row Tap",
      bio: "Back room, 120 standing.",
      addressLine1: "500 E Water St",
      addressLine2: "Suite 2",
      // No metro: the form asks one question, not two, so the scene has to be
      // derived from the city — and derived LOWERCASED, because every feed
      // filter and saved-search match compares against a lowercase metro.
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      capacity: 120,
      paInventory: { hasPA: true, mixerChannels: 12, micsAvailable: 4, monitors: 2, hasOperator: true },
      noiseCurfew: "Music ends at 11pm",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      foundingNumber: number;
      foundingMember: boolean;
    };

    const [row] = await db()
      .select()
      .from(schema.venues)
      .where(eq(schema.venues.id, body.id));
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      ownerUserId: ownerId,
      kind: "brewery",
      name: "The Full Row Tap",
      bio: "Back room, 120 standing.",
      metro: "milwaukee",
      addressLine1: "500 E Water St",
      addressLine2: "Suite 2",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      // Not the UTC column default: a venue stored as UTC is treated as an
      // unmigrated legacy row and cannot have a night posted against it.
      timeZone: "America/Chicago",
      capacity: 120,
      paInventory: { hasPA: true, mixerChannels: 12, micsAvailable: 4, monitors: 2, hasOperator: true },
      noiseCurfew: "Music ends at 11pm",
      status: "live",
    });
    // The metro centroid stands in until a geocoder exists, so a venue that was
    // never asked for coordinates is still inside a radius search.
    expect(row!.lat).toBeCloseTo(43.0389, 4);
    expect(row!.lng).toBeCloseTo(-87.9065, 4);
    expect(row!.foundingNumber).toBe(body.foundingNumber);
    expect(row!.foundingMember).toBe(body.foundingMember);
  });

  it("stores no coordinates for a metro it cannot place", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-d@venue-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    const res = await post(
      venueBody({ name: "Unknown Metro Room", city: "Sheboygan Falls" }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db()
      .select()
      .from(schema.venues)
      .where(eq(schema.venues.id, id));
    expect(row!.metro).toBe("sheboygan falls");
    // Null is "location unknown", which discovery treats as visible. A
    // fabricated fallback point — a default of 0,0 or a nearby city's centroid —
    // would either hide the room from every radius search or advertise it in a
    // scene it is not in.
    expect(row!.lat).toBeNull();
    expect(row!.lng).toBeNull();
    expect(row!.capacity).toBeNull();
    expect(row!.noiseCurfew).toBeNull();
    expect(row!.paInventory).toEqual({ hasPA: false });
  });

  it("keeps a metro the venue stated for itself, rather than its own city", async () => {
    const ownerId = await makeUser({ email: `${Date.now()}-e@venue-create.test` });
    sessionUserId.mockResolvedValue(ownerId);
    // A suburb room that wants to be found in the Milwaukee scene: the override
    // is the entire reason `metro` is a separate optional field.
    const res = await post(
      venueBody({ name: "Suburb Room", city: "Wauwatosa", metro: " Milwaukee " }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db()
      .select()
      .from(schema.venues)
      .where(eq(schema.venues.id, id));
    expect(row!.metro).toBe("milwaukee");
    expect(row!.city).toBe("Wauwatosa");
    expect(row!.lat).toBeCloseTo(43.0389, 4);
  });
});
