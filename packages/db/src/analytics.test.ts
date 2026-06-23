import { newId } from "@gigit/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, getPool } from "./client.js";
import {
  matchOpenSlotsForPerformer,
  matchSavedSearches,
  snapshotNightFacts,
} from "./analytics.js";
import {
  applications,
  bookings,
  performers,
  savedSearches,
  slots,
  users,
  venues,
} from "./schema.js";

describe("night facts + saved-search matching (integration)", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const nightDate = "2031-03-07"; // a Friday far in the future — collision-proof
  let gigSlotId: string;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values({ id: userId, email: `${userId}@t.test` });
    await d.insert(venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "brewery",
      name: "Analytics Test Taproom",
      metro: "analytics-testville",
      lat: 43,
      lng: -88,
      paInventory: { hasPA: true },
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "band",
      name: "Analytics Test Band",
      homeMetro: "analytics-testville",
      techNeeds: { inputs: 4 },
    });
    gigSlotId = newId("slot");
    await d.insert(slots).values({
      id: gigSlotId,
      venueId,
      metro: "analytics-testville",
      startsAt: new Date(`${nightDate}T20:00:00Z`),
      durationMinutes: 120,
      format: "comedy",
      budgetCents: 30_000,
      status: "filled",
    });
    const appId = newId("application");
    await d.insert(applications).values({ id: appId, slotId: gigSlotId, performerId, status: "offered" });
    await d.insert(bookings).values({
      id: newId("booking"),
      slotId: gigSlotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: `${nightDate}T20:00:00.000Z`,
        endsAt: `${nightDate}T22:00:00.000Z`,
      },
      offerExpiresAt: new Date(Date.now() + 72 * 3_600_000),
      agreementTemplateVer: "v1",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("snapshot records the gig night with format and budget; idempotent", async () => {
    await snapshotNightFacts(nightDate);
    const { rows } = await getPool().query(
      `select * from venue_night_facts where venue_id = $1 and night_date = $2`,
      [venueId, nightDate],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].had_booking).toBe(true);
    expect(rows[0].format).toBe("comedy");
    expect(rows[0].budget_cents).toBe(30_000);
    expect(rows[0].day_of_week).toBe(5); // Friday

    await snapshotNightFacts(nightDate); // re-run: no duplicate
    const { rows: again } = await getPool().query(
      `select count(*)::int as n from venue_night_facts where venue_id = $1 and night_date = $2`,
      [venueId, nightDate],
    );
    expect(again[0].n).toBe(1);
  });

  it("snapshot records a non-gig night as the baseline row", async () => {
    const quietNight = "2031-03-08";
    await snapshotNightFacts(quietNight);
    const { rows } = await getPool().query(
      `select had_booking, format from venue_night_facts where venue_id = $1 and night_date = $2`,
      [venueId, quietNight],
    );
    expect(rows[0].had_booking).toBe(false);
    expect(rows[0].format).toBeNull();
  });

  it("saved-search matching honors format/metro/budget and the `either` rule", async () => {
    // a second performer whose searches must NOT match — same run, so the
    // accreting dev/CI database can't contaminate the negative assertions
    const d = db();
    const userNo = newId("user");
    const performerNo = newId("performer");
    await d.insert(users).values({ id: userNo, email: `${userNo}@t.test` });
    await d.insert(performers).values({
      id: performerNo,
      ownerUserId: userNo,
      kind: "solo",
      name: "Analytics No-Match Act",
      homeMetro: "analytics-testville",
      techNeeds: { inputs: 1 },
    });
    const mkSearch = async (
      owner: string,
      s: { format?: string; metro?: string; minBudgetCents?: number },
    ) => {
      await d.insert(savedSearches).values({
        id: newId("search"),
        performerId: owner,
        format: s.format ?? null,
        metro: s.metro ?? null,
        minBudgetCents: s.minBudgetCents ?? null,
      });
    };
    await mkSearch(performerId, { format: "comedy", metro: "analytics-testville" }); // matches
    await mkSearch(performerNo, { format: "music", metro: "analytics-testville" }); // wrong format
    await mkSearch(performerNo, { format: "comedy", metro: "elsewhere" }); // wrong metro
    await mkSearch(performerNo, { minBudgetCents: 50_000, metro: "analytics-testville" }); // too pricey

    const matched = await matchSavedSearches(gigSlotId);
    expect(matched).toContain(userId);
    expect(matched).not.toContain(userNo);

    // an `either` slot matches a music-format search (the `either` rule)
    const eitherSlot = newId("slot");
    await d.insert(slots).values({
      id: eitherSlot,
      venueId,
      metro: "analytics-testville",
      startsAt: new Date("2031-04-01T20:00:00Z"),
      durationMinutes: 90,
      format: "either",
      budgetCents: 25_000,
    });
    const eitherMatched = await matchSavedSearches(eitherSlot);
    expect(eitherMatched).toContain(userNo); // music search matches `either`
  });

  it("matchOpenSlotsForPerformer: a new act fans out to venues with a fitting open slot", async () => {
    const d = db();
    const metro = "newact-testville"; // dedicated metro — collision-proof
    const vOwner = newId("user");
    const vId = newId("venue");
    await d.insert(users).values({ id: vOwner, email: `${vOwner}@t.test` });
    await d.insert(venues).values({
      id: vId,
      ownerUserId: vOwner,
      kind: "brewery",
      name: "New-Act Test Room",
      metro,
      lat: 43,
      lng: -88,
      paInventory: { hasPA: true },
    });
    const openComedy = newId("slot");
    await d.insert(slots).values({
      id: openComedy,
      venueId: vId,
      metro,
      startsAt: new Date("2031-05-01T20:00:00Z"),
      durationMinutes: 90,
      format: "comedy",
      budgetCents: 30_000,
      status: "open",
    });

    // mkPerformer returns the performer id so we can match on it directly.
    const mkPerformer = async (
      kind: string,
      home: string,
      rateMinCents?: number,
    ): Promise<string> => {
      const owner = newId("user");
      const id = newId("performer");
      await d.insert(users).values({ id: owner, email: `${owner}@t.test` });
      await d.insert(performers).values({
        id,
        ownerUserId: owner,
        kind,
        name: `New ${kind}`,
        homeMetro: home,
        techNeeds: { inputs: 1 },
        ...(rateMinCents !== undefined ? { rateMinCents } : {}),
      });
      return id;
    };

    // comedian in the metro → matches the open comedy slot
    const comicId = await mkPerformer("comedian", metro);
    expect(await matchOpenSlotsForPerformer(comicId)).toContain(vOwner);

    // band (→ music) vs comedy-only slot; comic in another metro; comic whose
    // floor exceeds the budget — none should be alerted about this venue
    const bandId = await mkPerformer("band", metro);
    const farId = await mkPerformer("comedian", "elsewhere-metro");
    const pricyId = await mkPerformer("comedian", metro, 50_000);
    expect(await matchOpenSlotsForPerformer(bandId)).not.toContain(vOwner);
    expect(await matchOpenSlotsForPerformer(farId)).not.toContain(vOwner);
    expect(await matchOpenSlotsForPerformer(pricyId)).not.toContain(vOwner);

    // a filled slot in the metro never alerts: the comic matches the OPEN slot
    // once, not the filled one (distinct owners)
    await d.insert(slots).values({
      id: newId("slot"),
      venueId: vId,
      metro,
      startsAt: new Date("2031-05-02T20:00:00Z"),
      durationMinutes: 90,
      format: "comedy",
      budgetCents: 30_000,
      status: "filled",
    });
    const m2 = await matchOpenSlotsForPerformer(comicId);
    expect(m2.filter((u) => u === vOwner)).toHaveLength(1);
  });
});
