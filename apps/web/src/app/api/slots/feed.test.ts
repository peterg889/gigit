import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

import { GET } from "./route";

const feed = (qs: string) => GET(new Request(`http://test/api/slots?${qs}`));
const ids = async (res: Response) =>
  ((await res.json()).slots as { slot: { id: string } }[]).map((r) => r.slot.id);

/**
 * The gig feed is the performer's front door (F2.3) and its filters had no
 * test: format, metro, budget floor, and the radius filter — including the
 * rule that venues without coordinates stay visible rather than vanish.
 */
describe("open slot feed filters", () => {
  const metro = `feed-${Date.now()}`;
  const vMke = newId("venue");
  const vNoCoords = newId("venue");
  const sMusic = newId("slot");
  const sComedy = newId("slot");
  const sCheap = newId("slot");
  const sNoCoords = newId("slot");
  const sPast = newId("slot");

  beforeAll(async () => {
    const d = db();
    const owner = newId("user");
    await d.insert(schema.users).values({ id: owner, email: `${owner}@t.test` });
    await d.insert(schema.venues).values([
      {
        id: vMke,
        ownerUserId: owner,
        kind: "bar",
        name: "Coords Bar",
        metro,
        lat: 43.0389,
        lng: -87.9065,
      },
      {
        id: vNoCoords,
        ownerUserId: owner,
        kind: "brewery",
        name: "Unknown Metro Taproom",
        metro,
        lat: null,
        lng: null,
      },
    ]);
    const future = new Date(Date.now() + 7 * 86_400_000);
    const base = {
      metro,
      startsAt: future,
      durationMinutes: 120,
      status: "open" as const,
    };
    await d.insert(schema.slots).values([
      { id: sMusic, venueId: vMke, format: "music", budgetCents: 40_000, ...base },
      { id: sComedy, venueId: vMke, format: "comedy", budgetCents: 20_000, ...base },
      { id: sCheap, venueId: vMke, format: "music", budgetCents: 5_000, ...base },
      { id: sNoCoords, venueId: vNoCoords, format: "music", budgetCents: 30_000, ...base },
      {
        id: sPast,
        venueId: vMke,
        format: "music",
        budgetCents: 40_000,
        metro,
        startsAt: new Date(Date.now() - 86_400_000),
        durationMinutes: 120,
        status: "open",
      },
    ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("returns only open, future slots for the metro", async () => {
    const got = await ids(await feed(`metro=${metro}`));
    expect(got).toEqual(expect.arrayContaining([sMusic, sComedy, sCheap, sNoCoords]));
    expect(got).not.toContain(sPast);
  });

  it("filters by format", async () => {
    const got = await ids(await feed(`metro=${metro}&format=comedy`));
    expect(got).toEqual([sComedy]);
  });

  it("applies the budget floor", async () => {
    const got = await ids(await feed(`metro=${metro}&min_budget_cents=25000`));
    expect(got).toEqual(expect.arrayContaining([sMusic, sNoCoords]));
    expect(got).not.toContain(sCheap);
  });

  it("radius filter keeps nearby venues and venues without coordinates", async () => {
    // Searching from downtown Milwaukee with a 40 km radius.
    const got = await ids(
      await feed(`metro=${metro}&lat=43.04&lng=-87.91&radius_km=40`),
    );
    expect(got).toEqual(expect.arrayContaining([sMusic, sNoCoords]));
  });

  it("radius filter excludes venues with far-away coordinates", async () => {
    // 1 km radius from a point ~100 km away: coordinate venues drop out,
    // the coordinate-less venue stays visible by design.
    const got = await ids(
      await feed(`metro=${metro}&lat=44.0&lng=-89.0&radius_km=1`),
    );
    expect(got).not.toContain(sMusic);
    expect(got).toContain(sNoCoords);
  });
});
