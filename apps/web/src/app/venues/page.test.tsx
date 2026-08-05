import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

import VenuesPage from "./page";
import { venueDirectoryRows } from "./directory";

describe("venue directory open-night counts", () => {
  const slotIds: string[] = [];
  const venueIds: string[] = [];
  const userIds: string[] = [];
  const suffix = newId("venue");
  const liveName = `000 OPEN NIGHT COUNT ${suffix}`;
  const hiddenName = `000 HIDDEN OPEN NIGHT ${suffix}`;
  const fixtureNow = new Date();
  let liveVenueId: string;
  let hiddenVenueId: string;

  beforeAll(async () => {
    const live = await makeVenue({ name: liveName });
    const hidden = await makeVenue({ name: hiddenName, status: "hidden" });
    liveVenueId = live.id;
    hiddenVenueId = hidden.id;
    venueIds.push(live.id, hidden.id);
    userIds.push(live.ownerUserId, hidden.ownerUserId);

    const future = new Date(fixtureNow.getTime() + 7 * 86_400_000);
    const past = new Date(fixtureNow.getTime() - 7 * 86_400_000);
    for (const [venueId, startsAt, status] of [
      [live.id, future, "open"],
      [live.id, future, "cancelled"],
      [live.id, past, "open"],
      [hidden.id, future, "open"],
    ] as const) {
      const id = newId("slot");
      slotIds.push(id);
      await db().insert(schema.slots).values({
        id,
        venueId,
        metro: "venue-directory-count-test",
        startsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 25_000,
        status,
      });
    }
  });

  afterAll(async () => {
    await db().delete(schema.slots).where(inArray(schema.slots.id, slotIds));
    await db().delete(schema.venues).where(inArray(schema.venues.id, venueIds));
    await db().delete(schema.users).where(inArray(schema.users.id, userIds));
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("counts only future open dates for live rooms", async () => {
    const rows = await venueDirectoryRows(db(), fixtureNow);
    expect(
      rows.find(({ venue }) => venue.id === liveVenueId),
    ).toMatchObject({ openSlots: 1 });
    expect(
      rows.find(({ venue }) => venue.id === hiddenVenueId),
    ).toBeUndefined();

    const html = renderToStaticMarkup(await VenuesPage());

    expect(html).toContain(liveName);
    expect(html).toContain(
      `href="/v/${liveVenueId}">1 open night — see the dates</a>`,
    );
    expect(html).not.toContain(hiddenName);
  });
});
