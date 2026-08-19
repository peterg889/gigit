import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { newId } from "@gigit/domain";
import { closeDb, schema } from "@gigit/db";

vi.stubGlobal("React", React);

/**
 * /slots is the act's discovery surface and it reads UNSCOPED tables — every
 * open future slot in the database, whoever seeded it. Three of the four empty
 * states only render when the whole board is empty, which can never be true of
 * the shared dev/CI database the rest of the suite keeps filling.
 *
 * So this file borrows the isolation the admin liquidity test uses: one
 * dedicated connection, held in a transaction that truncates `slots`, seeded
 * with a known population, and rolled back at the end. The difference is where
 * the swap happens — the admin page calls `getPool()` itself, while this page
 * reaches the database through `openSlotFeed`, which imports `db` from the db
 * package's own client module. Mocking that module (rather than the `@gigit/db`
 * barrel) is what puts the REAL feed query, the real auth lookups and the real
 * saved-search read on the isolated connection: no query text is restated here.
 */
const control = vi.hoisted(() => ({
  db: null as unknown as NodePgDatabase<typeof import("@gigit/db").schema>,
}));
vi.mock("../../../../../packages/db/dist/client.js", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, db: () => control.db };
});

const session = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(session.id),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import FeedPage from "./page";

const render = async (params: { format?: string; metro?: string } = {}) =>
  renderToStaticMarkup(await FeedPage({ searchParams: Promise.resolve(params) }));

describe("/slots feed page", () => {
  const venueId = newId("venue");
  const venueOwnerId = newId("user");
  const actUserId = newId("user");
  const actId = newId("performer");
  const dormantUserId = newId("user");
  const dormantActId = newId("performer");
  const seriesId = newId("series");
  /**
   * Frozen so the rendered wall-clock string can be asserted literally rather
   * than by re-running the formatter the page uses — a test that formats its own
   * expectation cannot notice the format changing. Only Date is faked: the pg
   * driver's timers must keep running.
   */
  const NOW = new Date("2026-09-10T12:00:00Z");
  let release: (() => void) | null = null;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    // max: 1 — the transaction below lives on a connection, so every query the
    // page makes has to land on that same one. It also serialises the parallel
    // profile lookups instead of firing them at a single checked-out client,
    // which pg deprecates.
    // The REAL pool, not the mocked db() the page sees. One checked-out client,
    // because the transaction below lives on a connection and every query the
    // page makes has to land on that same one.
    const real = await vi.importActual<typeof import("@gigit/db")>("@gigit/db");
    const client = await real.getPool().connect();
    release = () => client.release();
    control.db = drizzle(client, { schema });
    await control.db.execute(sql`begin`);
    // Fail fast rather than hang: truncate needs ACCESS EXCLUSIVE on slots and
    // everything cascading off it.
    await control.db.execute(sql`set local lock_timeout = '10s'`);
    await control.db.execute(sql`truncate slots cascade`);

    await control.db.insert(schema.users).values([
      { id: venueOwnerId, email: `${venueOwnerId}@feedpage.test` },
      { id: actUserId, email: `${actUserId}@feedpage.test` },
      { id: dormantUserId, email: `${dormantUserId}@feedpage.test` },
    ]);
    await control.db.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "brewery",
      name: "Kinnickinnic Brewhouse",
      metro: "milwaukee",
      addressLine1: "412 Kinnickinnic Ave",
      addressLine2: "Suite 2",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53204",
      timeZone: "America/Chicago",
    });
    await control.db.insert(schema.performers).values([
      {
        id: actId,
        ownerUserId: actUserId,
        kind: "band",
        name: "Feed Page Act",
        homeMetro: "milwaukee",
      },
      // Owned but not live: the branch that must offer account help rather than
      // the cold-market copy.
      {
        id: dormantActId,
        ownerUserId: dormantUserId,
        kind: "band",
        name: "Dormant Feed Act",
        homeMetro: "milwaukee",
        status: "hidden",
      },
    ]);
    await control.db.insert(schema.slotSeries).values({
      id: seriesId,
      venueId,
      metro: "milwaukee",
      pattern: { freq: "weekly", dayOfWeek: 4, durationMinutes: 120 },
      defaults: { format: "music", genrePrefs: [], budgetCents: 27_500, provides: {} },
    });
  });

  beforeEach(async () => {
    // Each case owns the whole board, because the empty states are defined by
    // its emptiness.
    await control.db.delete(schema.slots);
    session.id = null;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await control.db.execute(sql`rollback`);
    release?.();
    vi.unstubAllGlobals();
    // A no-op unless something reached past the mock and opened the real pool —
    // in which case leaving it open would hang the run.
    await closeDb();
  });

  /**
   * The listing body itself. Every figure here is one an act decides on before
   * clicking through, so a blank or lossy card is a booking that never happens:
   * the pay, the venue-LOCAL downbeat with its zone (an act reading a Central
   * time in Pacific turns up three hours off), how long they play, where the
   * room is, and the link to the room's own page — which for a long time was
   * reachable from nowhere but the venue's own dashboard.
   */
  it("renders the deal on an open future night", async () => {
    const slotId = newId("slot");
    const onceOffId = newId("slot");
    await control.db.insert(schema.slots).values([
      {
        id: slotId,
        venueId,
        seriesId,
        metro: "milwaukee",
        // 8:00 PM in Milwaukee; asserted as such, so rendering the UTC instant
        // (or dropping the zone label) is a failure rather than a near miss.
        startsAt: new Date("2026-11-13T02:00:00Z"),
        durationMinutes: 120,
        format: "music",
        budgetCents: 27_500,
      },
      {
        id: onceOffId,
        venueId,
        metro: "milwaukee",
        startsAt: new Date("2026-11-20T02:00:00Z"),
        durationMinutes: 90,
        format: "comedy",
        budgetCents: 15_000,
      },
    ]);

    const html = await render();

    expect(html).toContain("Kinnickinnic Brewhouse");
    expect(html).toContain(`href="/slots/${slotId}"`);
    expect(html).toContain("Thu, Nov 12, 8:00 PM CST");
    expect(html).toContain("120 min");
    expect(html).toContain('<span class="money">$275</span>');
    expect(html).toContain("412 Kinnickinnic Ave · Suite 2 · Milwaukee, WI · 53204");
    // The room's public page: PA specs, capacity and the reviews of the room the
    // act is about to apply to.
    expect(html).toContain(`href="/v/${venueId}"`);
    expect(html).toContain("Brewery · about this room");
    expect(html).toContain("Live music");
    // Exactly one of the two nights is a series occurrence, so a badge printed
    // unconditionally fails here just as loudly as a badge never printed.
    expect(html.match(/Recurring/g) ?? []).toHaveLength(1);
  });

  /**
   * Filters that match nothing must say so and offer a way back — and must not
   * promise the alerts card to someone who cannot see it. The alerts card is
   * gated on a live act, so "save an alert below" pointed a signed-out visitor
   * (or a venue) at nothing.
   */
  it("explains a filtered-to-nothing board without promising an alerts card nobody has", async () => {
    await control.db.insert(schema.slots).values({
      id: newId("slot"),
      venueId,
      metro: "milwaukee",
      startsAt: new Date("2026-11-13T02:00:00Z"),
      durationMinutes: 120,
      format: "music",
      budgetCents: 27_500,
    });

    const anonymous = await render({ metro: "madison" });
    expect(anonymous).toContain("No open gigs match these filters");
    expect(anonymous).toContain('href="/slots"');
    expect(anonymous).not.toMatch(/save an alert below/i);
    expect(anonymous).toContain('href="/venues"');

    session.id = actUserId;
    const act = await render({ metro: "madison" });
    expect(act).toContain("No open gigs match these filters");
    expect(act).toMatch(/save an alert below/i);
    // ...and the card it points at is genuinely on the page.
    expect(act).toContain("Gig alerts");
  });

  /**
   * A cold market shown to an act who already has a live profile. The one thing
   * they can do while the board is empty is stand up an alert, so this branch
   * must not spend its words on profile creation or on posting a date.
   */
  it("tells a live act why the board is empty and what to do about it", async () => {
    session.id = actUserId;

    const html = await render();

    expect(html).toMatch(/EightGig is new here/);
    expect(html).toMatch(/Save an alert below/i);
    expect(html).toContain("Gig alerts");
    expect(html).toContain('href="/venues"');
    // They have an act and cannot post a date; neither offer belongs here.
    expect(html).not.toContain("/onboarding?role=performer");
    expect(html).not.toMatch(/Post your first open date/i);
  });

  /**
   * An act whose profile is suspended or hidden. Repeating the cold-market copy
   * here would be a lie by omission — the board may be full and they simply
   * cannot act on it — so this branch names the real reason and sends them to
   * their account.
   */
  it("sends an owner whose profile is inactive to their account", async () => {
    session.id = dormantUserId;

    const html = await render();

    expect(html).toContain("Your marketplace profile is not active right now.");
    expect(html).toContain('href="/account"');
    expect(html).not.toMatch(/EightGig is new here/);
    // No live act, so no alerts card to save into.
    expect(html).not.toContain("Gig alerts");
  });

  /**
   * The signed-out fallback. This branch used to read "Venues can post an open
   * date" — copy addressed to a venue on the page an ACT lands on, offering the
   * one thing the reader cannot do. It must lead with what an act can do; the
   * venue offer stays, but second.
   */
  it("offers a signed-out visitor what an act can do, not what a venue can do", async () => {
    const html = await render();

    expect(html).toContain('href="/onboarding?role=performer"');
    expect(html).toMatch(/set up your act/i);
    expect(html).toContain('href="/venues"');
    expect(html.indexOf("role=performer")).toBeLessThan(html.indexOf("role=venue"));
    expect(html).not.toContain("Your marketplace profile is not active right now.");
  });

  /**
   * The cap is soonest-first for a reason: a crowded board must drop the dates
   * furthest out, never the nights closest to happening. Ordering by anything
   * else (or newest-first, the default a `created_at` index invites) hides the
   * gigs an act could still take while showing ones months away.
   */
  it("caps the board at 50 and drops the furthest-out dates, not the soonest", async () => {
    const ordered = Array.from({ length: 60 }, (_, i) => ({
      id: newId("slot"),
      venueId,
      metro: "milwaukee",
      startsAt: new Date(NOW.getTime() + (i + 1) * 86_400_000),
      durationMinutes: 90,
      format: "music",
      budgetCents: 10_000 + i,
    }));
    // Inserted furthest-out first, so insertion order is the exact reverse of
    // the order the page must render: a query that forgot to sort would fail.
    await control.db.insert(schema.slots).values([...ordered].reverse());

    const html = await render();

    const rendered = [...html.matchAll(/href="\/slots\/(slt_[^"]+)"/g)].map((m) => m[1]);
    expect(rendered).toHaveLength(50);
    expect(rendered).toEqual(ordered.slice(0, 50).map((s) => s.id));
    for (const dropped of ordered.slice(50)) expect(html).not.toContain(dropped.id);
  });
});
