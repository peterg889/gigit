import { newId } from "@gigit/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  OfferExpiredError,
  PerformerUnavailableError,
  SlotUnavailableError,
  createOffer,
  runBookingTransition,
} from "./transition.js";
import {
  applications,
  bookings,
  events,
  performers,
  slots,
  users,
  venues,
} from "./schema.js";

/** Full lifecycle against a real Postgres: the M0 exit-criterion test. */
describe("booking transition runner (integration)", () => {
  const userVenue = newId("user");
  const userBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const rivalPerformerId = newId("performer");
  let slotSequence = 0;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: userVenue, email: `${userVenue}@t.test` },
      { id: userBand, email: `${userBand}@t.test` },
    ]);
    await d.insert(venues).values({
      id: venueId,
      ownerUserId: userVenue,
      kind: "bar",
      name: "Test Bar",
      metro: "testville",
      lat: 43,
      lng: -87,
    });
    await d.insert(performers).values([
      {
        id: performerId,
        ownerUserId: userBand,
        kind: "band",
        name: "Test Band",
        homeMetro: "testville",
      },
      {
        id: rivalPerformerId,
        ownerUserId: userBand,
        kind: "solo",
        name: "Rival Act",
        homeMetro: "testville",
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeSlotWithApplications(
    startsAt = new Date(
      Date.now() + (7 + slotSequence++) * 86_400_000,
    ),
  ) {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const rivalAppId = newId("application");
    await d.insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 50_000,
    });
    await d.insert(applications).values([
      { id: appId, slotId, performerId },
      { id: rivalAppId, slotId, performerId: rivalPerformerId },
    ]);
    return { slotId, appId, rivalAppId, startsAt };
  }

  async function offerFor(slotId: string, appId: string, startsAt: Date) {
    return createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms: {
        amountCents: 50_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
  }

  it("walks offer → accept → (null payment) → confirmed, filling the slot and declining rivals", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);

    const accept = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      userBand,
    );
    expect(accept.to).toBe("confirming");

    // worker's NullPaymentGateway step:
    const paid = await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_SUCCEEDED" },
      "worker",
    );
    expect(paid.to).toBe("confirmed");

    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("filled");
    const [rival] = await d
      .select()
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(rival!.status).toBe("declined");

    // events tell the full story, in order (M0 exit criterion 2)
    const story = await d
      .select({ kind: events.kind, payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, bookingId))
      .orderBy(asc(events.id));
    expect(story.map((e) => e.kind)).toEqual([
      "booking.offered",
      "booking.transition",
      "booking.transition",
    ]);
    expect(story[1]!.payload).toMatchObject({ from: "offered", to: "confirming" });
    expect(story[2]!.payload).toMatchObject({ from: "confirming", to: "confirmed" });
  });

  it("venue cancellation inside 48h records a 100% fee", async () => {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 24 * 3_600_000); // tomorrow
    await d.insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt,
      durationMinutes: 60,
      format: "comedy",
      budgetCents: 20_000,
    });
    await d.insert(applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms: {
        amountCents: 20_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");

    const [venueBefore] = await d
      .select({ strikes: venues.reliabilityStrikes })
      .from(venues)
      .where(eq(venues.id, venueId));
    const cancelled = await runBookingTransition(
      bookingId,
      { kind: "VENUE_CANCELLED" },
      userVenue,
    );
    expect(cancelled.to).toBe("cancelled_by_venue");
    expect(cancelled.effects).toContainEqual({
      kind: "cancellation_fee",
      feeCents: 20_000,
      refundCents: 0,
    });

    // slot reopened by the in-tx effect
    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("open");
    const [venueAfter] = await d
      .select({ strikes: venues.reliabilityStrikes })
      .from(venues)
      .where(eq(venues.id, venueId));
    expect(venueAfter!.strikes).toBe(venueBefore!.strikes + 1);
  });

  it("rejects illegal transitions and stale-version concurrent updates", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);

    await expect(
      runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker"),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    // two concurrent accepts: exactly one wins
    const results = await Promise.allSettled([
      runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand),
      runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = (failed[0] as PromiseRejectedResult).reason;
    expect(
      err instanceof IllegalTransitionError || err instanceof ConcurrentUpdateError,
    ).toBe(true);

    const [row] = await db()
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row!.state).toBe("confirming");
    expect(row!.version).toBe(2);
  });

  it("allows only one firm outstanding offer per slot", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } =
      await makeSlotWithApplications();
    const terms = {
      amountCents: 50_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    };
    const first = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms,
    });

    await expect(
      createOffer({
        applicationId: rivalAppId,
        slotId,
        performerId: rivalPerformerId,
        venueId,
        actor: userVenue,
        terms,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    const [firstRow] = await d
      .select()
      .from(bookings)
      .where(eq(bookings.id, first));
    const [rivalApplication] = await d
      .select()
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(firstRow!.state).toBe("offered");
    expect(firstRow!.terms.timeZone).toBe("UTC");
    expect(rivalApplication!.status).toBe("submitted");
  });

  it("createOffer rejects terms whose endsAt is not after startsAt", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    await expect(
      createOffer({
        applicationId: appId,
        slotId,
        performerId,
        venueId,
        actor: userVenue,
        terms: {
          amountCents: 50_000,
          startsAt: startsAt.toISOString(),
          endsAt: startsAt.toISOString(), // equal → invalid
        },
      }),
    ).rejects.toThrow(/endsAt must be after startsAt/);
  });

  it("rejects an offer that does not match the advertised slot pay", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    await expect(
      createOffer({
        applicationId: appId,
        slotId,
        performerId,
        venueId,
        actor: userVenue,
        terms: {
          amountCents: 40_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      }),
    ).rejects.toThrow(/must match the advertised/);

    await expect(
      createOffer({
        applicationId: appId,
        slotId,
        performerId,
        venueId,
        actor: userVenue,
        terms: {
          amountCents: 50_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + 2 * 3_600_000,
          ).toISOString(),
          provides: { pa: true },
        },
      }),
    ).rejects.toThrow(/provisions must match/);

    const [application] = await db()
      .select()
      .from(applications)
      .where(eq(applications.id, appId));
    expect(application!.status).toBe("submitted");
  });

  it("performer cancellation strikes reliability and reopens the slot (payments off)", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    const [before] = await d
      .select({ s: performers.reliabilityStrikes })
      .from(performers)
      .where(eq(performers.id, performerId));

    const cancelled = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_CANCELLED" },
      userBand,
    );
    expect(cancelled.to).toBe("cancelled_by_performer");
    expect(cancelled.effects).toContainEqual({ kind: "reopen_slot" });
    expect(cancelled.effects).toContainEqual({ kind: "reliability_strike", against: "performer" });

    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("open"); // reopened, in-tx
    const [after] = await d
      .select({ s: performers.reliabilityStrikes })
      .from(performers)
      .where(eq(performers.id, performerId));
    expect(after!.s).toBe((before!.s ?? 0) + 1); // exactly one strike
  });

  it("drives the full happy lifecycle to 'released' under the null gateway", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    const r = await runBookingTransition(bookingId, { kind: "VENUE_CONFIRMED" }, userVenue);
    expect(r.to).toBe("released");
    expect(r.effects).toContainEqual({ kind: "release_funds", amountCents: 50_000 });
  });

  it("offer expiry returns the stranded application to 'submitted' so the slot is re-biddable (audit #6)", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    const [offered] = await d.select().from(applications).where(eq(applications.id, appId));
    expect(offered!.status).toBe("offered"); // parked while the offer is live

    const collapsed = await runBookingTransition(bookingId, { kind: "OFFER_EXPIRED" }, "worker");
    expect(collapsed.to).toBe("collapsed");

    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("open"); // slot reopened
    const [reset] = await d.select().from(applications).where(eq(applications.id, appId));
    expect(reset!.status).toBe("submitted"); // and the performer is no longer locked out
  });

  it("withdrawing a firm offer frees the slot for the next applicant", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } =
      await makeSlotWithApplications();
    const terms = {
      amountCents: 50_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    };
    const first = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms,
    });
    await expect(
      createOffer({
        applicationId: rivalAppId,
        slotId,
        performerId: rivalPerformerId,
        venueId,
        actor: userVenue,
        terms,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    const withdrawn = await runBookingTransition(
      first,
      { kind: "VENUE_CANCELLED" },
      userVenue,
    );
    expect(withdrawn.to).toBe("collapsed");

    const second = await createOffer({
      applicationId: rivalAppId,
      slotId,
      performerId: rivalPerformerId,
      venueId,
      actor: userVenue,
      terms,
    });
    const [secondRow] = await d
      .select()
      .from(bookings)
      .where(eq(bookings.id, second));
    const [firstApplication] = await d
      .select()
      .from(applications)
      .where(eq(applications.id, appId));
    expect(secondRow!.state).toBe("offered");
    expect(firstApplication!.status).toBe("submitted");
  });

  it("performer decline frees the slot and withdraws their application", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } =
      await makeSlotWithApplications();
    const terms = {
      amountCents: 50_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(
        startsAt.getTime() + 2 * 3_600_000,
      ).toISOString(),
    };
    const first = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms,
    });
    const declined = await runBookingTransition(
      first,
      { kind: "PERFORMER_DECLINED" },
      userBand,
    );
    expect(declined.to).toBe("collapsed");
    expect(declined.effects).toContainEqual({
      kind: "notify",
      template: "offer_declined",
      to: "venue",
    });
    const [application] = await d
      .select()
      .from(applications)
      .where(eq(applications.id, appId));
    expect(application!.status).toBe("withdrawn");

    await expect(
      createOffer({
        applicationId: rivalAppId,
        slotId,
        performerId: rivalPerformerId,
        venueId,
        actor: userVenue,
        terms,
      }),
    ).resolves.toMatch(/^bkg_/);
  });

  it("serializes concurrent accepts and rejects an overlapping performer booking", async () => {
    const startsAt = new Date(Date.now() + 60 * 86_400_000);
    const first = await makeSlotWithApplications(startsAt);
    const second = await makeSlotWithApplications(startsAt);
    const firstBooking = await offerFor(
      first.slotId,
      first.appId,
      first.startsAt,
    );
    const secondBooking = await offerFor(
      second.slotId,
      second.appId,
      second.startsAt,
    );

    const results = await Promise.allSettled([
      runBookingTransition(
        firstBooking,
        { kind: "PERFORMER_ACCEPTED" },
        userBand,
      ),
      runBookingTransition(
        secondBooking,
        { kind: "PERFORMER_ACCEPTED" },
        userBand,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(failure?.reason).toBeInstanceOf(PerformerUnavailableError);
  });

  it("rejects acceptance after the firm offer deadline", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      offerTtlHours: 1,
      terms: {
        amountCents: 50_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
    });

    await expect(
      runBookingTransition(
        bookingId,
        { kind: "PERFORMER_ACCEPTED" },
        userBand,
        new Date(Date.now() + 2 * 3_600_000),
      ),
    ).rejects.toBeInstanceOf(OfferExpiredError);
  });

  it("DISPUTE_OPENED persists openedBy + reason into the event log (audit critic #1)", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(
      bookingId,
      { kind: "DISPUTE_OPENED", openedBy: "venue", reason: "act never showed up" },
      userVenue,
    );
    const rows = await d
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, bookingId))
      .orderBy(asc(events.id));
    const disputed = rows.find((e) => (e.payload as { to?: string }).to === "disputed");
    expect(disputed).toBeTruthy();
    // the disputant's account survives — the admin/AI brief reads events.payload
    expect(disputed!.payload).toMatchObject({
      openedBy: "venue",
      reason: "act never showed up",
    });
  });
});
