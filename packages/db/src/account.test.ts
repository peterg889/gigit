import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  deactivateAccount,
  windDownBookingForDeactivation,
} from "./account.js";
import { AccountUnavailableError } from "./account-gate.js";
import { closeDb, db, getPool } from "./client.js";
import {
  applications,
  bookings,
  events,
  ledgerEntries,
  performers,
  slots,
  slotSeries,
  techs,
  techSubslotApplications,
  techSubslots,
  users,
  venues,
} from "./schema.js";
import { makePerformer, makeUser, makeVenue } from "./test/factories.js";
import { createOffer, runBookingTransition } from "./transition.js";
import { cancelSeries } from "./series.js";

describe("account deactivation lifecycle", () => {
  afterAll(async () => {
    await closeDb();
  });

  async function bookedTech() {
    const venue = await makeVenue({ name: "Deactivation Room" });
    const performer = await makePerformer({ name: "Deactivation Act" });
    const userId = await makeUser();
    const techId = newId("tech");
    await db().insert(techs).values({
      id: techId,
      ownerUserId: userId,
      name: "Booked Tech",
      gear: "full_rig",
    });

    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    const slotId = newId("slot");
    await db().insert(slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "milwaukee",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    const bookingId = newId("booking");
    await db().insert(bookings).values({
      id: bookingId,
      slotId,
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    const subslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
      techId,
      state: "booked",
    });
    return {
      userId,
      techId,
      bookingId,
      subslotId,
      venueId: venue.id,
      performerId: performer.id,
    };
  }

  async function additionalConfirmedBooking(
    venueId: string,
    performerId: string,
  ): Promise<string> {
    const startsAt = new Date(Date.now() + 16 * 86_400_000);
    const slotId = newId("slot");
    const bookingId = newId("booking");
    await db().insert(slots).values({
      id: slotId,
      venueId,
      metro: "milwaukee",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    return bookingId;
  }

  async function bookingWaitingForPayment() {
    const venue = await makeVenue({ name: "Deactivation Booking Room" });
    const performer = await makePerformer({ name: "Deactivation Booking Act" });
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "deactivation-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(applications).values({
      id: applicationId,
      slotId,
      performerId: performer.id,
    });
    const bookingId = await createOffer({
      applicationId,
      slotId,
      performerId: performer.id,
      venueId: venue.id,
      actor: venue.ownerUserId,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      performer.ownerUserId,
    );
    return { venue, performer, slotId, applicationId, bookingId, startsAt };
  }

  it("cancels booked work before deleting and hiding the tech account", async () => {
    const seeded = await bookedTech();
    const pendingSubslotId = newId("slot");
    const pendingApplicationId = newId("application");
    const pendingBookingId = await additionalConfirmedBooking(
      seeded.venueId,
      seeded.performerId,
    );
    await db().insert(techSubslots).values({
      id: pendingSubslotId,
      bookingId: pendingBookingId,
      payer: "venue",
      budgetCents: 8_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(techSubslotApplications).values({
      id: pendingApplicationId,
      subslotId: pendingSubslotId,
      techId: seeded.techId,
    });

    await deactivateAccount(seeded.userId);

    const [subslot] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, seeded.subslotId));
    expect(subslot).toMatchObject({ state: "open", techId: null });
    const [user] = await db()
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(user).toMatchObject({ status: "deleted", email: null });
    const [tech] = await db()
      .select({ status: techs.status })
      .from(techs)
      .where(eq(techs.id, seeded.techId));
    expect(tech!.status).toBe("hidden");
    const pending = await db()
      .select({ id: techSubslotApplications.id })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.id, pendingApplicationId));
    expect(pending).toHaveLength(0);
    const withdrawn = await db()
      .select({ kind: events.kind, payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, pendingSubslotId));
    expect(withdrawn).toEqual(
      expect.arrayContaining([
        {
          kind: "subslot.application_withdrawn",
          payload: expect.objectContaining({ techId: seeded.techId }),
        },
      ]),
    );
  });

  it("sweeps work committed before the account gate and rejects work after it", async () => {
    const venue = await makeVenue({ name: "Creator Gate Room" });
    const performer = await makePerformer({ name: "Creator Gate Act" });
    const startsAt = new Date(Date.now() + 21 * 86_400_000);
    const terms = {
      amountCents: 24_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    };
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "account-gate",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 24_000,
    });
    await db().insert(applications).values({
      id: applicationId,
      slotId,
      performerId: performer.id,
    });

    let announceGate!: () => void;
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>((resolve) => {
      announceGate = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const offer = createOffer({
      applicationId,
      slotId,
      performerId: performer.id,
      venueId: venue.id,
      actor: venue.ownerUserId,
      terms,
      lifecycleHooks: {
        afterAccountLock: async () => {
          announceGate();
          await released;
        },
      },
    });
    await gateHeld;
    const deactivation = deactivateAccount(performer.ownerUserId);
    releaseGate();
    const bookingId = await offer;
    await deactivation;

    const [sweptBooking] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(sweptBooking?.state).toBe("collapsed");
    const [sweptApplication] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, applicationId));
    expect(sweptApplication?.status).toBe("withdrawn");

    const laterSlotId = newId("slot");
    const laterApplicationId = newId("application");
    const laterStartsAt = new Date(startsAt.getTime() + 86_400_000);
    await db().insert(slots).values({
      id: laterSlotId,
      venueId: venue.id,
      metro: "account-gate",
      startsAt: laterStartsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 24_000,
    });
    await db().insert(applications).values({
      id: laterApplicationId,
      slotId: laterSlotId,
      performerId: performer.id,
    });
    await expect(
      createOffer({
        applicationId: laterApplicationId,
        slotId: laterSlotId,
        performerId: performer.id,
        venueId: venue.id,
        actor: venue.ownerUserId,
        terms: {
          ...terms,
          startsAt: laterStartsAt.toISOString(),
          endsAt: new Date(
            laterStartsAt.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(AccountUnavailableError);
    const laterBookings = await db()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.slotId, laterSlotId));
    expect(laterBookings).toHaveLength(0);
    const [laterApplication] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, laterApplicationId));
    expect(laterApplication?.status).toBe("submitted");
  });

  it("does not cancel a replacement tech booked after the deactivation worklist read", async () => {
    const seeded = await bookedTech();
    const replacementUserId = await makeUser();
    const replacementTechId = newId("tech");
    await db().insert(techs).values({
      id: replacementTechId,
      ownerUserId: replacementUserId,
      name: "Replacement Tech",
      gear: "partial",
    });

    let announceWorklist!: (value: { subslotId: string; techId: string }) => void;
    let releaseTransition!: () => void;
    const worklistRead = new Promise<{ subslotId: string; techId: string }>(
      (resolve) => {
        announceWorklist = resolve;
      },
    );
    const released = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const deactivation = deactivateAccount(seeded.userId, {
      beforeTechTransition: async (subslotId, expectedTechId) => {
        announceWorklist({ subslotId, techId: expectedTechId });
        await released;
      },
    });

    expect(await worklistRead).toEqual({
      subslotId: seeded.subslotId,
      techId: seeded.techId,
    });
    try {
      // Simulate the original tech cancelling and the payer selecting someone
      // else before deactivation reaches this work item.
      await db()
        .update(techSubslots)
        .set({ techId: replacementTechId, version: 2 })
        .where(eq(techSubslots.id, seeded.subslotId));
    } finally {
      releaseTransition();
    }
    await deactivation;

    const [subslot] = await db()
      .select({
        state: techSubslots.state,
        techId: techSubslots.techId,
      })
      .from(techSubslots)
      .where(eq(techSubslots.id, seeded.subslotId));
    expect(subslot).toEqual({ state: "booked", techId: replacementTechId });
    const [replacement] = await db()
      .select({ status: techs.status, strikes: techs.reliabilityStrikes })
      .from(techs)
      .where(eq(techs.id, replacementTechId));
    expect(replacement).toEqual({ status: "live", strikes: 0 });
    const [departed] = await db()
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(departed?.status).toBe("deleted");
  });

  it("continues when a parent cascade resolves a pending tech application after the worklist read", async () => {
    const seeded = await bookedTech();
    const pendingSubslotId = newId("slot");
    const pendingApplicationId = newId("application");
    const pendingBookingId = await additionalConfirmedBooking(
      seeded.venueId,
      seeded.performerId,
    );
    await db().insert(techSubslots).values({
      id: pendingSubslotId,
      bookingId: pendingBookingId,
      payer: "venue",
      budgetCents: 7_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(techSubslotApplications).values({
      id: pendingApplicationId,
      subslotId: pendingSubslotId,
      techId: seeded.techId,
    });

    let announceWorklist!: () => void;
    let releaseWithdrawal!: () => void;
    const worklistRead = new Promise<void>((resolve) => {
      announceWorklist = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseWithdrawal = resolve;
    });
    const deactivation = deactivateAccount(seeded.userId, {
      beforeTechApplicationWithdrawal: async (subslotId, techId) => {
        if (subslotId !== pendingSubslotId || techId !== seeded.techId) return;
        announceWorklist();
        await released;
      },
    });
    await worklistRead;
    try {
      await db()
        .update(techSubslotApplications)
        .set({ status: "declined" })
        .where(eq(techSubslotApplications.id, pendingApplicationId));
    } finally {
      releaseWithdrawal();
    }
    await deactivation;

    const [application] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.id, pendingApplicationId));
    expect(application?.status).toBe("declined");
    const [user] = await db()
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(user?.status).toBe("deleted");
  });

  it("does not delete the account when a booked-work transition really fails", async () => {
    const seeded = await bookedTech();
    const suffix = seeded.subslotId.slice(-16).toLowerCase();
    const functionName = `fail_subslot_event_${suffix}`;
    const triggerName = `fail_subslot_event_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.subject_id = '${seeded.subslotId}' and new.kind = 'subslot.transition' then
          raise exception 'forced subslot event failure';
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

    try {
      await expect(deactivateAccount(seeded.userId)).rejects.toThrow(
        'Failed query: insert into "events"',
      );
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    const [subslot] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, seeded.subslotId));
    expect(subslot).toMatchObject({ state: "booked", techId: seeded.techId });
    const [user] = await db()
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(user!.status).toBe("active");
    expect(user!.email).not.toBeNull();
    const [tech] = await db()
      .select({ status: techs.status })
      .from(techs)
      .where(eq(techs.id, seeded.techId));
    expect(tech!.status).toBe("live");
  });

  it("performer deactivation collapses confirming and compensates a later success", async () => {
    const seeded = await bookingWaitingForPayment();
    await db()
      .update(bookings)
      .set({ paymentRef: `pi_deactivate_${seeded.bookingId}` })
      .where(eq(bookings.id, seeded.bookingId));

    await deactivateAccount(seeded.performer.ownerUserId);
    const [closed] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingId));
    expect(closed?.state).toBe("collapsed");
    const [application] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, seeded.applicationId));
    expect(application?.status).toBe("withdrawn");
    const [slot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, seeded.slotId));
    expect(slot?.status).toBe("open");
    const [profile] = await db()
      .select({ status: performers.status })
      .from(performers)
      .where(eq(performers.id, seeded.performer.id));
    expect(profile?.status).toBe("hidden");
    const transitionHistory = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, seeded.bookingId));
    expect(transitionHistory).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            event: "PAYMENT_FAILED",
            from: "confirming",
            to: "collapsed",
            reason: "account_deactivated",
          }),
        },
      ]),
    );

    await runBookingTransition(
      seeded.bookingId,
      { kind: "PAYMENT_SUCCEEDED" },
      "stripe",
    );
    const money = await db()
      .select({ type: ledgerEntries.entryType, amount: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, seeded.bookingId));
    expect(money).toEqual(
      expect.arrayContaining([
        { type: "charge", amount: 30_000 },
        { type: "refund", amount: 30_000 },
      ]),
    );
    expect(money).toHaveLength(2);
  });

  it("venue deactivation collapses confirming before cancelling the reopened date", async () => {
    const seeded = await bookingWaitingForPayment();
    const waitingAct = await makePerformer({
      name: "Pending Applicant During Venue Deactivation",
    });
    const waitingApplicationId = newId("application");
    await db().insert(applications).values({
      id: waitingApplicationId,
      slotId: seeded.slotId,
      performerId: waitingAct.id,
    });
    await deactivateAccount(seeded.venue.ownerUserId);

    const [closed] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingId));
    expect(closed?.state).toBe("collapsed");
    const [slot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, seeded.slotId));
    expect(slot?.status).toBe("cancelled");
    const resolvedApplications = await Promise.all(
      [seeded.applicationId, waitingApplicationId].map(async (applicationId) => {
        const [application] = await db()
          .select({
            status: applications.status,
            reason: applications.declineReason,
          })
          .from(applications)
          .where(eq(applications.id, applicationId));
        return application;
      }),
    );
    expect(resolvedApplications).toEqual([
      { status: "declined", reason: "slot_cancelled" },
      { status: "declined", reason: "slot_cancelled" },
    ]);
    const applicationEvents = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, seeded.slotId));
    expect(applicationEvents).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            applicationId: waitingApplicationId,
            reason: "slot_cancelled",
            effects: expect.arrayContaining([
              expect.objectContaining({ template: "application_cancelled" }),
            ]),
          }),
        },
      ]),
    );
    const [profile] = await db()
      .select({ status: venues.status })
      .from(venues)
      .where(eq(venues.id, seeded.venue.id));
    expect(profile?.status).toBe("hidden");
  });

  it("locks series before winding booking slots during venue deactivation", async () => {
    const seeded = await bookingWaitingForPayment();
    const seriesId = newId("series");
    await db().insert(slotSeries).values({
      id: seriesId,
      venueId: seeded.venue.id,
      metro: "deactivation-test",
      pattern: {
        freq: "weekly",
        dayOfWeek: seeded.startsAt.getUTCDay(),
        startTimeUtc: "20:00",
        durationMinutes: 120,
      },
      defaults: {
        format: "music",
        genrePrefs: [],
        budgetCents: 30_000,
        provides: {},
      },
    });
    await db()
      .update(slots)
      .set({ seriesId })
      .where(eq(slots.id, seeded.slotId));

    let announceSeriesLock!: () => void;
    let releaseSeriesLock!: () => void;
    let stateAtSeriesLock: string | undefined;
    const seriesLocked = new Promise<void>((resolve) => {
      announceSeriesLock = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSeriesLock = resolve;
    });
    const deactivation = deactivateAccount(seeded.venue.ownerUserId, {
      afterSeriesLock: async () => {
        const [booking] = await db()
          .select({ state: bookings.state })
          .from(bookings)
          .where(eq(bookings.id, seeded.bookingId));
        stateAtSeriesLock = booking?.state;
        announceSeriesLock();
        await released;
      },
    });
    await seriesLocked;
    // If this ever reads collapsed, booking/slot work happened before the
    // series lock and the series↔slot deadlock has been reintroduced.
    expect(stateAtSeriesLock).toBe("confirming");

    const concurrentCancellation = cancelSeries(
      seriesId,
      seeded.venue.ownerUserId,
    );
    releaseSeriesLock();
    await deactivation;
    expect(await concurrentCancellation).toBe(0);

    const [series] = await db()
      .select({ status: slotSeries.status })
      .from(slotSeries)
      .where(eq(slotSeries.id, seriesId));
    expect(series?.status).toBe("cancelled");
    const [slot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, seeded.slotId));
    expect(slot?.status).toBe("cancelled");
  });

  it("retries when an offered booking advances to confirming during deactivation", async () => {
    const seeded = await bookingWaitingForPayment();
    // Put the fixture back on the earlier state, then move it after the helper
    // has read `offered` but before its transition is allowed to write.
    await db()
      .update(bookings)
      .set({ state: "offered", performerAcceptedAt: null })
      .where(eq(bookings.id, seeded.bookingId));
    const [beforeRace] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingId));
    expect(beforeRace?.state).toBe("offered");

    let announceFirstRead!: (state: string) => void;
    let releaseFirstAttempt!: () => void;
    const firstRead = new Promise<string>((resolve) => {
      announceFirstRead = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const observedStates: string[] = [];
    const deactivation = windDownBookingForDeactivation(
      seeded.bookingId,
      "performer",
      seeded.performer.ownerUserId,
      {
        beforeTransition: async (state, attempt) => {
          observedStates.push(state);
          if (attempt === 0) {
            announceFirstRead(state);
            await released;
          }
        },
      },
    );

    expect(await firstRead).toBe("offered");
    try {
      await db()
        .update(bookings)
        .set({
          state: "confirming",
          version: 2,
          performerAcceptedAt: new Date(),
        })
        .where(eq(bookings.id, seeded.bookingId));
    } finally {
      releaseFirstAttempt();
    }
    await deactivation;
    expect(observedStates).toEqual(["offered", "confirming"]);

    const [closed] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingId));
    expect(closed?.state).toBe("collapsed");
    const history = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, seeded.bookingId));
    expect(history).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            event: "PAYMENT_FAILED",
            from: "confirming",
            reason: "account_deactivated",
          }),
        },
      ]),
    );
  });
});
