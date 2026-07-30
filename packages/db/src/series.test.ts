import { newId } from "@gigit/domain";
import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import {
  createSeries,
  materializeSeries,
  cancelSeries,
  findRebookTarget,
  SERIES_HORIZON,
} from "./series.js";
import {
  applications,
  bookings,
  performers,
  slots,
  slotSeries,
  users,
  venues,
} from "./schema.js";

describe("slot series (integration)", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  let seriesId: string;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values({ id: userId, email: `${userId}@t.test` });
    await d.insert(venues).values({
      id: venueId,
      ownerUserId: userId,
      kind: "brewery",
      name: "Series Test Taproom",
      metro: "testville",
      lat: 43,
      lng: -87.9,
      paInventory: { hasPA: true },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a series and materializes the full horizon", async () => {
    seriesId = await createSeries({
      venueId,
      metro: "testville",
      actor: userId,
      pattern: { freq: "weekly", dayOfWeek: 5, startTimeUtc: "20:00", durationMinutes: 120 },
      defaults: { format: "music", genrePrefs: [], budgetCents: 40000, provides: { pa: true } },
    });
    const rows = await db()
      .select()
      .from(slots)
      .where(eq(slots.seriesId, seriesId));
    expect(rows).toHaveLength(SERIES_HORIZON);
    expect(rows.every((s) => s.status === "open")).toBe(true);
    expect(rows.every((s) => s.source === "series")).toBe(true);
    expect(rows.every((s) => s.budgetCents === 40000)).toBe(true);
    expect(rows.every((s) => s.startsAt.getUTCDay() === 5)).toBe(true);
  });

  it("re-materializing is idempotent", async () => {
    const created = await materializeSeries(seriesId, "worker");
    expect(created).toBe(0);
    const rows = await db().select().from(slots).where(eq(slots.seriesId, seriesId));
    expect(rows).toHaveLength(SERIES_HORIZON);
  });

  it("cancelling closes future open occurrences and stops materialization", async () => {
    const cancelled = await cancelSeries(seriesId, userId);
    expect(cancelled).toBe(SERIES_HORIZON);
    const stillOpen = await db()
      .select()
      .from(slots)
      .where(
        and(eq(slots.seriesId, seriesId), eq(slots.status, "open"), gt(slots.startsAt, new Date())),
      );
    expect(stillOpen).toHaveLength(0);
    const [s] = await db().select().from(slotSeries).where(eq(slotSeries.id, seriesId));
    expect(s.status).toBe("cancelled");
    expect(await materializeSeries(seriesId, "worker")).toBe(0);
  });

  it("findRebookTarget: next open series night, same act, same pay; skips applied/ineligible", async () => {
    const d = db();
    // a fresh series of its own (the shared one above gets cancelled)
    const rbSeries = await createSeries({
      venueId,
      metro: "testville",
      actor: userId,
      pattern: { freq: "weekly", dayOfWeek: 3, startTimeUtc: "20:00", durationMinutes: 120 },
      defaults: { format: "music", genrePrefs: [], budgetCents: 35000, provides: { pa: true } },
    });
    const occ = await d
      .select()
      .from(slots)
      .where(eq(slots.seriesId, rbSeries))
      .orderBy(slots.startsAt);
    expect(occ.length).toBeGreaterThanOrEqual(3);

    const performerId = newId("performer");
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "band",
      name: "Rebook Test Band",
      homeMetro: "testville",
      techNeeds: { inputs: 4 },
    });

    const mkBooking = async (slotId: string, startsAt: Date, state: string) => {
      const id = newId("booking");
      await d.insert(bookings).values({
        id,
        slotId,
        performerId,
        venueId,
        state,
        terms: {
          amountCents: 35000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 120 * 60_000).toISOString(),
        },
        offerExpiresAt: new Date(Date.now() + 72 * 3_600_000),
        agreementTemplateVer: "v1",
      });
      return id;
    };

    // a released booking on the first occurrence → target is the second, same pay
    const bookingId = await mkBooking(occ[0].id, occ[0].startsAt, "released");
    await d.update(slots).set({ status: "filled" }).where(eq(slots.id, occ[0].id));
    const t1 = await findRebookTarget(bookingId);
    expect(t1?.slotId).toBe(occ[1].id);
    expect(t1?.amountCents).toBe(35000);
    expect(t1?.provides).toEqual({ pa: true });
    expect(t1?.performerId).toBe(performerId);

    // if the act already applied to occ[1], it's skipped → occ[2]
    await d.insert(applications).values({
      id: newId("application"),
      slotId: occ[1].id,
      performerId,
      status: "submitted",
    });
    expect((await findRebookTarget(bookingId))?.slotId).toBe(occ[2].id);

    // an offered (not-yet-engaged) booking is not rebook-eligible
    const offered = await mkBooking(occ[2].id, occ[2].startsAt, "offered");
    expect(await findRebookTarget(offered)).toBeNull();
  });

  it("findRebookTarget: a one-off booking rebooks onto the room's next open night", async () => {
    const d = db();
    // Requiring a series meant a venue that posted a ONE-OFF and loved the act
    // had no rebook path at all — and at launch the one-off venue is the
    // majority. This is the case that had no coverage.
    const oneOffOwner = newId("user");
    const oneOffVenue = newId("venue");
    const soloAct = newId("performer");
    const actOwner = newId("user");
    await d.insert(users).values([
      { id: oneOffOwner, email: `${oneOffOwner}@t.test` },
      { id: actOwner, email: `${actOwner}@t.test` },
    ]);
    await d.insert(venues).values({
      id: oneOffVenue, ownerUserId: oneOffOwner, kind: "bar",
      name: "One Off Room", metro: "testville", lat: 43, lng: -87,
    });
    await d.insert(performers).values({
      id: soloAct, ownerUserId: actOwner, kind: "solo",
      name: "One Off Act", homeMetro: "testville", techNeeds: { inputs: 2 },
    });

    const mkSlot = async (daysOut: number, status = "open") => {
      const id = newId("slot");
      const startsAt = new Date(Date.now() + daysOut * 86_400_000);
      await d.insert(slots).values({
        id, venueId: oneOffVenue, metro: "testville", startsAt,
        durationMinutes: 120, format: "music", budgetCents: 28_000, status,
      });
      return { id, startsAt };
    };

    // the played night, and two later open nights with no series between them
    const played = await mkSlot(3, "filled");
    const next = await mkSlot(17);
    const later = await mkSlot(31);

    const bookingId = newId("booking");
    await d.insert(bookings).values({
      id: bookingId, slotId: played.id, performerId: soloAct, venueId: oneOffVenue,
      state: "released",
      terms: {
        amountCents: 28_000,
        startsAt: played.startsAt.toISOString(),
        endsAt: new Date(played.startsAt.getTime() + 120 * 60_000).toISOString(),
      },
      offerExpiresAt: new Date(Date.now() + 72 * 3_600_000),
      agreementTemplateVer: "v1",
    });

    // the SOONEST open night at that room, not the later one
    expect((await findRebookTarget(bookingId))?.slotId).toBe(next.id);

    // ...and once the act has applied there, it moves on to the next
    await d.insert(applications).values({
      id: newId("application"), slotId: next.id, performerId: soloAct,
    });
    expect((await findRebookTarget(bookingId))?.slotId).toBe(later.id);

    // a different room's open night is never a target
    const otherRoom = newId("venue");
    const otherOwner = newId("user");
    await d.insert(users).values({ id: otherOwner, email: `${otherOwner}@t.test` });
    await d.insert(venues).values({
      id: otherRoom, ownerUserId: otherOwner, kind: "bar",
      name: "Someone Else's Room", metro: "testville", lat: 43, lng: -87,
    });
    await d.insert(slots).values({
      id: newId("slot"), venueId: otherRoom, metro: "testville",
      startsAt: new Date(Date.now() + 5 * 86_400_000),
      durationMinutes: 120, format: "music", budgetCents: 28_000, status: "open",
    });
    expect((await findRebookTarget(bookingId))?.slotId).toBe(later.id);
  });
});