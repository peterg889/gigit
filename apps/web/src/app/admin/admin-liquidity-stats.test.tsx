import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
vi.stubGlobal("React", React);

/**
 * The dashboard's own SQL, run against real Postgres over a controlled
 * population. The page reads unscoped tables (`from slots`, `from bookings`),
 * so it cannot be asserted against the shared dev/CI database that the rest of
 * the suite keeps filling. Instead the page is handed a dedicated client whose
 * transaction truncates the relevant tables, seeds a known population, and is
 * rolled back — the real query text still executes against a real planner.
 */
interface TxClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

const control = vi.hoisted(() => ({ client: null as unknown as TxClient }));
vi.mock("@gigit/db", async (original) => ({
  ...(await original<typeof import("@gigit/db")>()),
  getPool: () => control.client,
}));

const sessionUserId = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(sessionUserId.id),
}));

import AdminPage from "./page";

/** The <Row k v> pairs the page renders, flattened to a lookup. */
function metrics(node: React.ReactNode, out: Record<string, string> = {}) {
  if (Array.isArray(node)) {
    for (const child of node) metrics(child, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;
  const props = node.props as { k?: string; v?: unknown; children?: React.ReactNode };
  if (typeof props.k === "string") out[props.k] = String(props.v ?? "—");
  return metrics(props.children, out);
}

describe("admin liquidity statistics", () => {
  const adminId = newId("user");
  const venueOwnerId = newId("user");
  const venueId = newId("venue");
  const performerIds = [newId("performer"), newId("performer"), newId("performer")];
  let client: TxClient;

  /**
   * Time-to-fill in hours for the five filled slots. Deliberately right-skewed:
   * the median is 3 and the mean is 20, so a mean masquerading as a median
   * cannot pass this test by coincidence.
   */
  const FILL_HOURS = [1, 2, 3, 4, 90];

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: adminId, email: `${adminId}@liquidity.test` },
      { id: venueOwnerId, email: `${venueOwnerId}@liquidity.test` },
    ]);
    await d
      .insert(schema.actorRoles)
      .values({ id: newId("role"), userId: adminId, kind: "admin" });

    // The real pool, not the mocked getPool the page sees.
    const real = await vi.importActual<typeof import("@gigit/db")>("@gigit/db");
    client = (await real.getPool().connect()) as unknown as TxClient;
    await client.query("begin");
    // Fail fast rather than hang if another connection is mid-transaction:
    // truncate needs ACCESS EXCLUSIVE on every cascaded table.
    await client.query("set local lock_timeout = '10s'");
    await client.query("truncate slots cascade");

    await client.query(
      `insert into venues (id, owner_user_id, kind, name, metro) values ($1,$2,'bar','Liquidity Bar','liq-metro')
       on conflict (id) do nothing`,
      [venueId, venueOwnerId],
    );
    for (const [i, performerId] of performerIds.entries()) {
      const ownerId = newId("user");
      await client.query(
        "insert into users (id, email) values ($1,$2) on conflict (id) do nothing",
        [ownerId, `${ownerId}@liquidity.test`],
      );
      await client.query(
        `insert into performers (id, owner_user_id, kind, name, home_metro)
         values ($1,$2,'band',$3,'liq-metro') on conflict (id) do nothing`,
        [performerId, ownerId, `Liquidity Act ${i}`],
      );
    }

    const slotIds: string[] = [];
    for (const hours of FILL_HOURS) {
      const slotId = newId("slot");
      slotIds.push(slotId);
      await client.query(
        `insert into slots (id, venue_id, metro, starts_at, duration_minutes, format,
                            budget_cents, status, created_at)
         values ($1,$2,'liq-metro', now() + interval '30 days', 90, 'music', 20000,
                 'filled', now() - make_interval(hours => $3))`,
        [slotId, venueId, hours],
      );
      await client.query(
        `insert into bookings (id, slot_id, performer_id, venue_id, state, terms,
                               offer_expires_at, created_at)
         values ($1,$2,$3,$4,'released','{"amountCents":20000,"startsAt":"2026-01-01T00:00:00Z","endsAt":"2026-01-01T02:00:00Z"}'::jsonb,
                 now() + interval '30 days', now())`,
        [newId("booking"), slotId, performerIds[0], venueId],
      );
    }
    // A draft slot: never visible to an act, so its zero must not dilute the
    // per-slot application depth.
    await client.query(
      `insert into slots (id, venue_id, metro, starts_at, duration_minutes, format,
                          budget_cents, status)
       values ($1,$2,'liq-metro', now() + interval '30 days', 90, 'music', 20000, 'draft')`,
      [newId("slot"), venueId],
    );

    // Depth: 3 applications on the first slot, 2 on the second, 0 on the other
    // three published slots → mean 1.0 per published slot. Counting only slots
    // that received something would say 2.5; counting the draft too, 0.8.
    for (const performerId of performerIds) {
      await client.query(
        "insert into applications (id, slot_id, performer_id) values ($1,$2,$3)",
        [newId("application"), slotIds[0], performerId],
      );
    }
    for (const performerId of performerIds.slice(0, 2)) {
      await client.query(
        "insert into applications (id, slot_id, performer_id) values ($1,$2,$3)",
        [newId("application"), slotIds[1], performerId],
      );
    }

    control.client = client;
    sessionUserId.id = adminId;
  });

  afterAll(async () => {
    await client.query("rollback");
    client.release();
    await closeDb();
    vi.unstubAllGlobals();
  });

  it("reports the median time-to-fill, not the mean", async () => {
    const m = metrics(await AdminPage());
    // median(1,2,3,4,90) = 3; mean = 20.
    expect(m["Median time-to-fill (h)"]).toBe("3");
    expect(Object.keys(m)).toContain("Median time-to-fill (h)");
  });

  it("averages applications over every published slot, including empty ones", async () => {
    const m = metrics(await AdminPage());
    // (3 + 2 + 0 + 0 + 0) / 5 published slots.
    expect(m["Avg applications per slot"]).toBe("1.0");
  });
});
