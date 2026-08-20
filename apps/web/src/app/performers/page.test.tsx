import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makePerformer, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import PerformerSearchPage from "./page";

describe("performer invite dates", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let performer: Awaited<ReturnType<typeof makePerformer>>;
  const freeSlotId = newId("slot");
  const offeredSlotId = newId("slot");
  const confirmingSlotId = newId("slot");
  const offeredBookingId = newId("booking");
  const confirmingBookingId = newId("booking");

  beforeAll(async () => {
    venue = await makeVenue({ name: "Invite Hold Room" });
    performer = await makePerformer({
      name: "Invite Hold Act",
      homeMetro: "held-invite-test",
    });
    const startsAt = new Date(Date.now() + 86_400_000);
    await db().insert(schema.slots).values(
      [freeSlotId, offeredSlotId, confirmingSlotId].map((id, index) => ({
        id,
        venueId: venue.id,
        metro: "held-invite-test",
        startsAt: new Date(startsAt.getTime() + index * 86_400_000),
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000 + index * 1_000,
      })),
    );
    await db().insert(schema.bookings).values([
      {
        id: offeredBookingId,
        slotId: offeredSlotId,
        venueId: venue.id,
        performerId: performer.id,
        state: "offered",
        terms: {
          amountCents: 31_000,
          startsAt: new Date(startsAt.getTime() + 86_400_000).toISOString(),
          endsAt: new Date(startsAt.getTime() + 86_400_000 + 7_200_000).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() + 3_600_000),
      },
      {
        id: confirmingBookingId,
        slotId: confirmingSlotId,
        venueId: venue.id,
        performerId: performer.id,
        state: "confirming",
        terms: {
          amountCents: 32_000,
          startsAt: new Date(startsAt.getTime() + 2 * 86_400_000).toISOString(),
          endsAt: new Date(startsAt.getTime() + 2 * 86_400_000 + 7_200_000).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() + 3_600_000),
      },
    ]);
  });

  afterAll(async () => {
    await db()
      .delete(schema.bookings)
      .where(inArray(schema.bookings.id, [offeredBookingId, confirmingBookingId]));
    await db()
      .delete(schema.slots)
      .where(inArray(schema.slots.id, [freeSlotId, offeredSlotId, confirmingSlotId]));
    await db().delete(schema.performers).where(inArray(schema.performers.id, [performer.id]));
    await db().delete(schema.venues).where(inArray(schema.venues.id, [venue.id]));
    await db()
      .delete(schema.users)
      .where(inArray(schema.users.id, [venue.ownerUserId, performer.ownerUserId]));
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("offers only genuinely free dates in the invite form", async () => {
    sessionUserId.mockResolvedValue(venue.ownerUserId);
    const html = renderToStaticMarkup(
      await PerformerSearchPage({
        searchParams: Promise.resolve({ metro: "held-invite-test" }),
      }),
    );

    expect(html).toContain("Invite Hold Act");
    expect(html).toContain(`value="${freeSlotId}"`);
    expect(html).not.toContain(`value="${offeredSlotId}"`);
    expect(html).not.toContain(`value="${confirmingSlotId}"`);
  });

  /**
   * "Find an act" is one of four discovery links in the global nav, so every act
   * clicks it eventually. The gate is correct — only a venue may invite or
   * message, which is what stops cold DMs — but it used to answer a band with a
   * "Set up your venue" button, which is not a thing a band wants to do.
   */
  it("does not tell an act to go set up a venue", async () => {
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const html = renderToStaticMarkup(
      await PerformerSearchPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).not.toContain("/onboarding?role=venue");
    expect(html).not.toMatch(/Set up your venue/i);
    // Sent somewhere that is actually theirs instead.
    expect(html).toContain('href="/slots"');
    // And still gated: no roster, no invite form.
    expect(html).not.toContain(`value="${freeSlotId}"`);
  });
});

/**
 * The three filters and the ordering are the whole of "compare local acts" —
 * every assertion the file had before this one passes with the WHERE clause and
 * the ORDER BY deleted, because a single fixture is returned either way.
 *
 * Every fixture lives in one made-up metro. The dev database carries thousands
 * of live acts and the query is `limit(100)`, so a fixture that shared a real
 * metro would either be pushed off the page by strangers or, worse, make an
 * absence assertion pass because the row never made the cut in the first place.
 */
describe("performer search filters and ordering", () => {
  const metro = "g19-act-search";
  const otherMetro = "g19-other-metro";
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let folkBand: Awaited<ReturnType<typeof makePerformer>>;
  let comic: Awaited<ReturnType<typeof makePerformer>>;
  let metalBand: Awaited<ReturnType<typeof makePerformer>>;
  let elsewhereBand: Awaited<ReturnType<typeof makePerformer>>;

  const FOLK = "G19 Folk Band";
  const COMIC = "G19 Standup Comic";
  const METAL = "G19 Metal Band";
  const ELSEWHERE = "G19 Elsewhere Folk Band";

  beforeAll(async () => {
    // The suite above drops the React global in its `afterAll`, which runs
    // before this block's fixtures. Without re-stubbing it, every render here
    // throws "React is not defined" — a harness failure wearing the costume of
    // a page bug.
    vi.stubGlobal("React", React);
    venue = await makeVenue({ name: "G19 Searching Room" });
    folkBand = await makePerformer({ name: FOLK, kind: "band", homeMetro: metro });
    comic = await makePerformer({ name: COMIC, kind: "comedian", homeMetro: metro });
    metalBand = await makePerformer({ name: METAL, kind: "band", homeMetro: metro });
    // Same kind and same genre as the folk band, one metro away: the control
    // that makes the metro assertion mean something rather than restating the
    // kind and genre ones.
    elsewhereBand = await makePerformer({
      name: ELSEWHERE,
      kind: "band",
      homeMetro: otherMetro,
    });

    // Strikes and creation dates are set here rather than through the factory
    // because they are the sort keys, and both are set AGAINST the insertion
    // order on purpose. The act with three strikes is the oldest, so sorting by
    // creation alone floats it to the top; and of the two clean acts the one
    // inserted LAST joined first, so dropping the createdAt tiebreak leaves
    // them in the order Postgres happens to hand back. Only the real two-key
    // sort produces metal, comic, folk.
    for (const [act, strikes, createdAt, genreTags] of [
      [folkBand, 3, "2020-01-01T00:00:00.000Z", ["folk", "americana"]],
      [comic, 0, "2020-03-01T00:00:00.000Z", ["standup"]],
      [metalBand, 0, "2020-02-01T00:00:00.000Z", ["metal"]],
      [elsewhereBand, 0, "2020-01-15T00:00:00.000Z", ["folk"]],
    ] as [Awaited<ReturnType<typeof makePerformer>>, number, string, string[]][])
      await db()
        .update(schema.performers)
        .set({
          reliabilityStrikes: strikes,
          createdAt: new Date(createdAt),
          genreTags,
        })
        .where(eq(schema.performers.id, act.id));
  });

  afterAll(async () => {
    const ids = [folkBand.id, comic.id, metalBand.id, elsewhereBand.id];
    await db().delete(schema.performers).where(inArray(schema.performers.id, ids));
    await db().delete(schema.venues).where(inArray(schema.venues.id, [venue.id]));
    await db()
      .delete(schema.users)
      .where(
        inArray(schema.users.id, [
          venue.ownerUserId,
          folkBand.ownerUserId,
          comic.ownerUserId,
          metalBand.ownerUserId,
          elsewhereBand.ownerUserId,
        ]),
      );
    vi.unstubAllGlobals();
    await closeDb();
  });

  async function search(
    searchParams: { kind?: string; genre?: string; metro?: string },
  ) {
    sessionUserId.mockResolvedValue(venue.ownerUserId);
    return renderToStaticMarkup(
      await PerformerSearchPage({ searchParams: Promise.resolve(searchParams) }),
    );
  }

  it("narrows the roster by metro, kind and genre", async () => {
    const byMetro = await search({ metro });
    expect(byMetro).toContain(FOLK);
    expect(byMetro).toContain(COMIC);
    expect(byMetro).toContain(METAL);
    expect(byMetro).not.toContain(ELSEWHERE);

    // A venue types a city, not a slug. The metro filter lowercases and trims
    // before comparing, and without that every hand-typed search is a dead end
    // that reads as "no acts here yet".
    expect(await search({ metro: "  G19-Act-Search  " })).toContain(COMIC);

    const byKind = await search({ metro, kind: "comedian" });
    expect(byKind).toContain(COMIC);
    expect(byKind).not.toContain(FOLK);
    expect(byKind).not.toContain(METAL);

    // Containment, not equality: the folk band's tags are ["folk","americana"],
    // so an `=` on the JSON array would silently match nobody.
    const byGenre = await search({ metro, genre: "folk" });
    expect(byGenre).toContain(FOLK);
    expect(byGenre).not.toContain(COMIC);
    expect(byGenre).not.toContain(METAL);

    // And a filter that matches nothing says so, instead of falling back to the
    // "no acts have joined yet" copy that blames an empty platform.
    const noMatch = await search({ metro, genre: "polka" });
    expect(noMatch).toContain("No acts match those filters.");
    expect(noMatch).not.toContain(FOLK);
  });

  it("ranks acts by strikes first and then by how long they have been here", async () => {
    const html = await search({ metro });
    const at = (name: string) => html.indexOf(name);
    expect(at(FOLK)).toBeGreaterThan(-1);

    // Clean records first, longest-standing among equals — so the act carrying
    // three no-shows cannot hold the top of every venue's list on the strength
    // of having signed up before anyone else.
    expect(at(METAL)).toBeLessThan(at(COMIC));
    expect(at(COMIC)).toBeLessThan(at(FOLK));
  });
});
