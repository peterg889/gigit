import {
  localDateTimeParts,
  newId,
  patternFromFirst,
  zonedDateTimeToDate,
} from "@gigit/domain";
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
  events,
  performers,
  slots,
  slotSeries,
  users,
  venues,
} from "./schema.js";
import { SlotCancellationBlockedError } from "./slot-cancellation.js";
import { makePerformer } from "./test/factories.js";
import { createOffer, runBookingTransition } from "./transition.js";

describe("slot series (integration)", () => {
  const userId = newId("user");
  const venueId = newId("venue");
  let seriesId: string;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values({ id: userId, email: `${userId}@t.test` });
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
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

  it("materializes the exact selected first night first and remains idempotent", async () => {
    const timeZone = "America/Chicago";
    const targetLocal = localDateTimeParts(
      new Date(Date.now() + 35 * 86_400_000),
      timeZone,
    );
    const firstStartsAt = zonedDateTimeToDate(
      {
        year: targetLocal.year,
        month: targetLocal.month,
        day: targetLocal.day,
        hour: 20,
        minute: 15,
      },
      timeZone,
    );
    // This matching weekday is still in the future, so the pre-fix generator
    // would have materialized it even though the venue selected a later night.
    expect(firstStartsAt.getTime() - 7 * 86_400_000).toBeGreaterThan(
      Date.now(),
    );

    const anchoredSeriesId = await createSeries({
      venueId,
      metro: "testville",
      actor: userId,
      pattern: patternFromFirst(
        firstStartsAt,
        120,
        "weekly",
        timeZone,
      ),
      defaults: {
        format: "music",
        genrePrefs: [],
        budgetCents: 41_500,
        provides: { pa: true },
        notes: "anchored integration series",
      },
    });
    const [stored] = await db()
      .select({ pattern: slotSeries.pattern })
      .from(slotSeries)
      .where(eq(slotSeries.id, anchoredSeriesId));
    expect(stored?.pattern.firstStartsAt).toBe(firstStartsAt.toISOString());

    const occurrences = await db()
      .select({ id: slots.id, startsAt: slots.startsAt })
      .from(slots)
      .where(eq(slots.seriesId, anchoredSeriesId))
      .orderBy(slots.startsAt);
    expect(occurrences).toHaveLength(SERIES_HORIZON);
    expect(occurrences[0]?.startsAt.toISOString()).toBe(
      firstStartsAt.toISOString(),
    );
    expect(
      occurrences.filter(
        (occurrence) => occurrence.startsAt.getTime() === firstStartsAt.getTime(),
      ),
    ).toHaveLength(1);
    expect(
      occurrences.every(
        (occurrence) => occurrence.startsAt.getTime() >= firstStartsAt.getTime(),
      ),
    ).toBe(true);

    const before = occurrences.map((occurrence) => ({
      id: occurrence.id,
      startsAt: occurrence.startsAt.toISOString(),
    }));
    expect(await materializeSeries(anchoredSeriesId, "worker")).toBe(0);
    const after = await db()
      .select({ id: slots.id, startsAt: slots.startsAt })
      .from(slots)
      .where(eq(slots.seriesId, anchoredSeriesId))
      .orderBy(slots.startsAt);
    expect(
      after.map((occurrence) => ({
        id: occurrence.id,
        startsAt: occurrence.startsAt.toISOString(),
      })),
    ).toEqual(before);
  });

  it("rolls back the series and its event when initial materialization fails", async () => {
    const beforeSeries = await db()
      .select({ id: slotSeries.id })
      .from(slotSeries)
      .where(eq(slotSeries.venueId, venueId));
    const beforeEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.kind, "series.created"));

    await expect(
      createSeries({
        venueId,
        metro: "testville",
        actor: userId,
        pattern: {
          freq: "weekly",
          dayOfWeek: 5,
          startTimeLocal: "20:00",
          timeZone: "Not/A_Time_Zone",
          durationMinutes: 120,
        },
        defaults: {
          format: "music",
          genrePrefs: [],
          budgetCents: 40_000,
          provides: { pa: true },
        },
      }),
    ).rejects.toThrow();

    const afterSeries = await db()
      .select({ id: slotSeries.id })
      .from(slotSeries)
      .where(eq(slotSeries.venueId, venueId));
    const afterEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.kind, "series.created"));
    expect(afterSeries).toHaveLength(beforeSeries.length);
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it("re-materializing is idempotent", async () => {
    const created = await materializeSeries(seriesId, "worker");
    expect(created).toBe(0);
    const rows = await db().select().from(slots).where(eq(slots.seriesId, seriesId));
    expect(rows).toHaveLength(SERIES_HORIZON);
  });

  it("cancelling closes future open occurrences and stops materialization", async () => {
    const [appliedSlot] = await db()
      .select()
      .from(slots)
      .where(eq(slots.seriesId, seriesId))
      .orderBy(slots.startsAt);
    const applicant = await makePerformer({ name: "Cancelled Series Applicant" });
    const applicationId = newId("application");
    await db().insert(applications).values({
      id: applicationId,
      slotId: appliedSlot!.id,
      performerId: applicant.id,
    });
    const cancelled = await cancelSeries(seriesId, userId);
    expect(cancelled).toBe(SERIES_HORIZON);
    const stillOpen = await db()
      .select()
      .from(slots)
      .where(
        and(eq(slots.seriesId, seriesId), eq(slots.status, "open"), gt(slots.startsAt, new Date())),
      );
    expect(stillOpen).toHaveLength(0);
    const [application] = await db()
      .select({
        status: applications.status,
        reason: applications.declineReason,
      })
      .from(applications)
      .where(eq(applications.id, applicationId));
    expect(application).toEqual({
      status: "declined",
      reason: "slot_cancelled",
    });
    const [event] = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.subjectId, appliedSlot!.id),
          eq(events.kind, "application.declined"),
        ),
      );
    expect(event?.payload).toMatchObject({
      applicationId,
      reason: "slot_cancelled",
      effects: [
        {
          kind: "notify",
          template: "application_cancelled",
          to: "performer",
        },
      ],
    });
    const [s] = await db().select().from(slotSeries).where(eq(slotSeries.id, seriesId));
    expect(s.status).toBe("cancelled");
    expect(await materializeSeries(seriesId, "worker")).toBe(0);
  });

  it("leaves the whole series active while an occurrence is confirming", async () => {
    const activeSeriesId = await createSeries({
      venueId,
      metro: "testville",
      actor: userId,
      pattern: {
        freq: "weekly",
        dayOfWeek: 1,
        startTimeUtc: "19:00",
        durationMinutes: 120,
      },
      defaults: {
        format: "music",
        genrePrefs: [],
        budgetCents: 31_000,
        provides: { pa: true },
      },
    });
    const occurrences = await db()
      .select()
      .from(slots)
      .where(eq(slots.seriesId, activeSeriesId))
      .orderBy(slots.startsAt);
    const performer = await makePerformer({ name: "Confirming Series Act" });
    const offeredApplicationId = newId("application");
    const pendingApplicationId = newId("application");
    await db().insert(applications).values([
      {
        id: offeredApplicationId,
        slotId: occurrences[0]!.id,
        performerId: performer.id,
      },
      {
        id: pendingApplicationId,
        slotId: occurrences[1]!.id,
        performerId: performer.id,
      },
    ]);
    const bookingId = await createOffer({
      applicationId: offeredApplicationId,
      slotId: occurrences[0]!.id,
      performerId: performer.id,
      venueId,
      actor: userId,
      terms: {
        amountCents: occurrences[0]!.budgetCents,
        startsAt: occurrences[0]!.startsAt.toISOString(),
        endsAt: new Date(
          occurrences[0]!.startsAt.getTime() +
            occurrences[0]!.durationMinutes * 60_000,
        ).toISOString(),
        provides: occurrences[0]!.provides,
      },
    });
    await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      performer.ownerUserId,
    );

    await expect(cancelSeries(activeSeriesId, userId)).rejects.toBeInstanceOf(
      SlotCancellationBlockedError,
    );
    const [series] = await db()
      .select({ status: slotSeries.status })
      .from(slotSeries)
      .where(eq(slotSeries.id, activeSeriesId));
    expect(series?.status).toBe("active");
    const occurrenceStatuses = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.seriesId, activeSeriesId));
    expect(occurrenceStatuses.every((slot) => slot.status === "open")).toBe(true);
    const [pending] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, pendingApplicationId));
    expect(pending?.status).toBe("submitted");

    await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_FAILED", reason: "test_cleanup" },
      "test",
    );
    expect(await cancelSeries(activeSeriesId, userId)).toBe(SERIES_HORIZON);
  });

  it("findRebookTarget: next open series night, same act, target pay; skips applied/ineligible", async () => {
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

    // A tempting one-off deliberately starts before the next series night.
    // Its null series_id used to sort ahead of TRUE under PostgreSQL's default
    // DESC null ordering, defeating the product's same-series preference.
    const earlierOneOffId = newId("slot");
    await d.insert(slots).values({
      id: earlierOneOffId,
      venueId,
      metro: "testville",
      startsAt: new Date(occ[1]!.startsAt.getTime() - 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 99_000,
      source: "manual",
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

    // a released booking on the first occurrence → target is the second at its
    // own advertised pay (the series happens to advertise the same amount)
    const bookingId = await mkBooking(occ[0].id, occ[0].startsAt, "released");
    await d.update(slots).set({ status: "filled" }).where(eq(slots.id, occ[0].id));
    const t1 = await findRebookTarget(bookingId);
    expect(t1?.slotId).toBe(occ[1].id);
    expect(t1?.slotId).not.toBe(earlierOneOffId);
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
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: oneOffVenue, ownerUserId: oneOffOwner, kind: "bar",
      name: "One Off Room", metro: "testville", lat: 43, lng: -87,
    });
    await d.insert(performers).values({
      id: soloAct, ownerUserId: actOwner, kind: "solo",
      name: "One Off Act", homeMetro: "testville", techNeeds: { inputs: 2 },
    });

    const mkSlot = async (
      daysOut: number,
      status = "open",
      format = "music",
      budgetCents = 28_000,
    ) => {
      const id = newId("slot");
      const startsAt = new Date(Date.now() + daysOut * 86_400_000);
      await d.insert(slots).values({
        id, venueId: oneOffVenue, metro: "testville", startsAt,
        durationMinutes: 120, format, budgetCents, status,
      });
      return { id, startsAt };
    };

    // The earlier comedy night is incompatible with this music act. The two
    // later compatible nights intentionally advertise different pay so a
    // re-book cannot silently reuse the original booking's amount.
    const played = await mkSlot(3, "filled");
    const incompatible = await mkSlot(10, "open", "comedy", 10_000);
    const next = await mkSlot(17, "open", "music", 32_000);
    const later = await mkSlot(31, "open", "either", 34_000);

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

    // the soonest COMPATIBLE open night at that room, with that night's pay
    const firstTarget = await findRebookTarget(bookingId);
    expect(firstTarget?.slotId).toBe(next.id);
    expect(firstTarget?.slotId).not.toBe(incompatible.id);
    expect(firstTarget?.amountCents).toBe(32_000);

    // ...and once the act has applied there, it moves on to the next
    await d.insert(applications).values({
      id: newId("application"), slotId: next.id, performerId: soloAct,
    });
    const secondTarget = await findRebookTarget(bookingId);
    expect(secondTarget?.slotId).toBe(later.id);
    expect(secondTarget?.amountCents).toBe(34_000);

    await d
      .update(performers)
      .set({ status: "hidden" })
      .where(eq(performers.id, soloAct));
    expect(await findRebookTarget(bookingId)).toBeNull();
    await d
      .update(performers)
      .set({ status: "live" })
      .where(eq(performers.id, soloAct));
    await d
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, actOwner));
    expect(await findRebookTarget(bookingId)).toBeNull();
    await d
      .update(users)
      .set({ status: "active" })
      .where(eq(users.id, actOwner));

    // a different room's open night is never a target
    const otherRoom = newId("venue");
    const otherOwner = newId("user");
    await d.insert(users).values({ id: otherOwner, email: `${otherOwner}@t.test` });
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
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

  it("materializes a venue-local pattern that holds its wall time across DST", async () => {
    const d = db();
    // Every venue fixture used to default to UTC, so `venueLocationIsComplete`
    // was false everywhere and this branch — the one real venues take — never ran
    // against the database. Both existing cases here use the legacy startTimeUtc
    // shape, so `(pattern.startTimeUtc ?? "00:00")` could have swallowed a broken
    // local pattern and materialized every night at midnight UTC.
    const seriesId = await createSeries({
      venueId,
      metro: "testville",
      actor: userId,
      pattern: {
        freq: "weekly",
        dayOfWeek: 6, // Saturday
        startTimeLocal: "21:00",
        timeZone: "America/Chicago",
        durationMinutes: 120,
      },
      defaults: {
        format: "music",
        genrePrefs: [],
        budgetCents: 30_000,
        provides: { pa: true },
      },
    });

    const occurrences = await d
      .select({ startsAt: slots.startsAt })
      .from(slots)
      .where(eq(slots.seriesId, seriesId))
      .orderBy(slots.startsAt);
    expect(occurrences.length).toBeGreaterThanOrEqual(3);

    // Every night is 9pm in the ROOM, whatever the UTC offset happens to be.
    for (const o of occurrences) {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        minute: "2-digit",
        weekday: "short",
        hour12: false,
      }).format(o.startsAt);
      expect(local).toContain("21:00");
      expect(local).toContain("Sat");
    }

    // ...and re-materializing is idempotent, which is what the unique index on
    // the resolved instant depends on.
    const before = occurrences.length;
    await materializeSeries(seriesId, "worker");
    const after = await d
      .select({ id: slots.id })
      .from(slots)
      .where(eq(slots.seriesId, seriesId));
    expect(after.length).toBe(before);
  });
});
