import {
  AGREEMENT_TEMPLATE_VERSION,
  newId,
  performerReliability,
} from "@gigit/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import {
  AccountUnavailableError,
  MarketplaceProfileUnavailableError,
} from "./account-gate.js";
import {
  ConcurrentUpdateError,
  IllegalTransitionError,
  OfferExpiredError,
  PaymentReferenceConflictError,
  PerformerUnavailableError,
  SlotUnavailableError,
  createOffer,
  runBookingTransition,
} from "./transition.js";
import { performerReliabilityStats } from "./reliability.js";
import {
  applications,
  bookings,
  events,
  ledgerEntries,
  performers,
  slots,
  threadParticipants,
  threads,
  users,
  venues,
} from "./schema.js";

/** Full lifecycle against a real Postgres: the M0 exit-criterion test. */
describe("booking transition runner (integration)", () => {
  const userVenue = newId("user");
  const userBand = newId("user");
  // The rival is a separate act, so a separate account: performers_owner_uq
  // enforces one live act profile per user, which this fixture used to break.
  const userRival = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const rivalPerformerId = newId("performer");
  let slotSequence = 0;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: userVenue, email: `${userVenue}@t.test` },
      { id: userBand, email: `${userBand}@t.test` },
      { id: userRival, email: `${userRival}@t.test` },
    ]);
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
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
        ownerUserId: userRival,
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

    const [offered] = await d
      .select({ agreementTemplateVer: bookings.agreementTemplateVer })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(offered!.agreementTemplateVer).toBe(AGREEMENT_TEMPLATE_VERSION);

    const [thread] = await d
      .select({
        id: threads.id,
        createdByUserId: threads.createdByUserId,
      })
      .from(threads)
      .where(eq(threads.subjectId, bookingId));
    expect(thread).toMatchObject({ createdByUserId: userVenue });
    const participants = await d
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, thread!.id));
    expect(participants.map((row) => row.userId).sort()).toEqual(
      [userVenue, userBand].sort(),
    );
    const [threadOpened] = await d
      .select({ kind: events.kind, payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, thread!.id));
    expect(threadOpened).toMatchObject({
      kind: "thread.booking_opened",
      payload: { bookingId },
    });

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

  it("tells each losing applicant the night went elsewhere", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");

    // The bulk decline used to update rows and emit nothing, so an act that
    // lost a slot never heard back — the single most common way an application
    // ends was silent. Each loser now gets its own addressed event.
    const declines = await d
      .select({ kind: events.kind, payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, slotId))
      .orderBy(asc(events.id));
    expect(declines.map((e) => e.kind)).toEqual(["application.declined"]);
    expect(declines[0]!.payload).toMatchObject({
      applicationId: rivalAppId,
      reason: "slot_filled",
      effects: [{ kind: "notify", template: "application_declined", to: "performer" }],
    });
    // the winner is never told they lost
    expect(
      declines.some(
        (e) => (e.payload as { applicationId?: string }).applicationId === appId,
      ),
    ).toBe(false);
  });

  it("records the act's mark-played claim and hands the night to the venue", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");

    const marked = await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_MARKED_PLAYED" },
      userBand,
    );
    // Same state on purpose — but it used to emit nothing and persist nothing,
    // so the act's press was indistinguishable from never pressing it and the
    // venue was never told the night was waiting on them.
    expect(marked.to).toBe("awaiting_confirmation");
    expect(marked.effects).toContainEqual({
      kind: "notify",
      template: "performer_marked_played",
      to: "venue",
    });
    const [b] = await d
      .select({ at: bookings.performerMarkedPlayedAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(b!.at).toBeInstanceOf(Date);
  });

  it("puts the passed-over applicants back in the running when a slot reopens", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");

    const [declined] = await d
      .select({ status: applications.status, reason: applications.declineReason })
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(declined).toEqual({ status: "declined", reason: "slot_filled" });

    // Cancelling reopened the slot but left the whole warm pool frozen: they
    // couldn't re-apply (unique index → 409) and the venue couldn't offer them
    // (createOffer requires 'submitted'), so the night could only be filled by
    // an act that had never applied.
    await runBookingTransition(bookingId, { kind: "VENUE_CANCELLED" }, userVenue);

    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("open");
    const [revived] = await d
      .select({ status: applications.status, reason: applications.declineReason })
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(revived).toEqual({ status: "submitted", reason: null });
  });

  it("leaves a venue's deliberate decline declined when the slot reopens", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } = await makeSlotWithApplications();
    // the venue turns the rival down on purpose before booking anyone
    await d
      .update(applications)
      .set({ status: "declined", declineReason: "venue_declined" })
      .where(eq(applications.id, rivalAppId));

    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "VENUE_CANCELLED" }, userVenue);

    const [still] = await d
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(still!.status).toBe("declined");
  });

  it("never lets an offer outlive the gig it is for", async () => {
    const d = db();
    // A venue posting Wednesday for Friday: the default 72h TTL would have put
    // expiry at Saturday — 48h AFTER the set — and a live offer holds the slot
    // exclusively, so one unresponsive act killed the night.
    const startsAt = new Date(Date.now() + 40 * 3_600_000);
    const slotId = newId("slot");
    const appId = newId("application");
    await d.insert(slots).values({
      id: slotId, venueId, metro: "testville", startsAt,
      durationMinutes: 120, format: "music", budgetCents: 50_000,
    });
    await d.insert(applications).values({ id: appId, slotId, performerId });
    const bookingId = await offerFor(slotId, appId, startsAt);

    const [b] = await d
      .select({ expires: bookings.offerExpiresAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(b!.expires.getTime()).toBeLessThan(startsAt.getTime());
    // and it leaves a real window before downbeat, not a photo finish
    expect(b!.expires.getTime()).toBeLessThanOrEqual(
      startsAt.getTime() - 12 * 3_600_000,
    );
  });

  it("still gives the act a full window when the gig is far out", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    const [b] = await d
      .select({ expires: bookings.offerExpiresAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    // the clamp must not shorten offers that were never at risk
    expect(b!.expires.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
  });

  it("uses downbeat as the hard deadline for a live close-in offer", async () => {
    const d = db();
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const { slotId, appId, rivalAppId } =
      await makeSlotWithApplications(startsAt);
    const bookingId = await offerFor(slotId, appId, startsAt);
    const [booking] = await d
      .select({ expiresAt: bookings.offerExpiresAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(booking!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(booking!.expiresAt.getTime()).toBeLessThanOrEqual(startsAt.getTime());

    await expect(
      runBookingTransition(
        bookingId,
        { kind: "PERFORMER_ACCEPTED" },
        userBand,
        startsAt,
      ),
    ).rejects.toBeInstanceOf(OfferExpiredError);

    const afterDownbeat = new Date(startsAt.getTime() + 1);
    const collapsed = await runBookingTransition(
      bookingId,
      { kind: "OFFER_EXPIRED" },
      "worker",
      afterDownbeat,
    );
    expect(collapsed.to).toBe("collapsed");
    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("expired");
    const applicationRows = await d
      .select({ id: applications.id, status: applications.status, reason: applications.declineReason })
      .from(applications)
      .where(eq(applications.slotId, slotId));
    expect(applicationRows).toEqual(
      expect.arrayContaining([
        { id: appId, status: "declined", reason: "slot_expired" },
        { id: rivalAppId, status: "declined", reason: "slot_expired" },
      ]),
    );
  });

  it("refuses a past open slot even before the expiry sweep reaches it", async () => {
    const d = db();
    const startsAt = new Date(Date.now() - 60_000);
    const { slotId, appId } = await makeSlotWithApplications(startsAt);

    await expect(offerFor(slotId, appId, startsAt)).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
    const [application] = await d
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(application!.status).toBe("submitted");
    const existing = await d
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.slotId, slotId));
    expect(existing).toHaveLength(0);
  });

  it("collapses and refunds immediately when payment arrives after downbeat", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } =
      await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await d.update(slots).set({ status: "expired" }).where(eq(slots.id, slotId));
    const afterDownbeat = new Date(startsAt.getTime() + 1);

    const late = await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_SUCCEEDED" },
      "worker",
      afterDownbeat,
    );
    expect(late.to).toBe("collapsed");
    expect(late.effects).toContainEqual({
      kind: "refund_funds",
      amountCents: 50_000,
    });
    expect(late.effects).toContainEqual({
      kind: "notify",
      template: "payment_late_refunded",
      to: "both",
    });
    const [closed] = await d
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(closed!.state).toBe("collapsed");
    const money = await d
      .select({ type: ledgerEntries.entryType, amount: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId))
      .orderBy(asc(ledgerEntries.id));
    expect(money).toEqual([
      { type: "charge", amount: 50_000 },
      { type: "refund", amount: 50_000 },
    ]);
    const [slot] = await d.select().from(slots).where(eq(slots.id, slotId));
    expect(slot!.status).toBe("expired");
    const applicationRows = await d
      .select({ id: applications.id, status: applications.status, reason: applications.declineReason })
      .from(applications)
      .where(eq(applications.slotId, slotId));
    expect(applicationRows).toEqual(
      expect.arrayContaining([
        { id: appId, status: "declined", reason: "slot_expired" },
        { id: rivalAppId, status: "declined", reason: "slot_expired" },
      ]),
    );
  });

  it("ledgers and refunds success delivered after a payment-window collapse exactly once", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    const paymentRef = `pi_late_${bookingId}`;

    const afterDownbeat = new Date(startsAt.getTime() + 1);
    const timedOut = await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_FAILED", reason: "payment_window_closed" },
      "worker",
      afterDownbeat,
    );
    expect(timedOut.to).toBe("collapsed");
    const historyBeforeSuccess = await d
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, bookingId))
      .orderBy(asc(events.id));
    expect(historyBeforeSuccess.at(-1)?.payload).toMatchObject({
      event: "PAYMENT_FAILED",
      from: "confirming",
      to: "collapsed",
      reason: "payment_window_closed",
    });

    const compensated = await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_SUCCEEDED", paymentRef },
      "stripe",
      new Date(afterDownbeat.getTime() + 1),
    );
    expect(compensated).toMatchObject({ from: "collapsed", to: "collapsed" });
    expect(compensated.effects).toContainEqual({
      kind: "refund_funds",
      amountCents: 50_000,
    });
    const money = await d
      .select({
        type: ledgerEntries.entryType,
        amount: ledgerEntries.amountCents,
        paymentRef: ledgerEntries.paymentRef,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId))
      .orderBy(asc(ledgerEntries.id));
    expect(money).toEqual([
      {
        type: "charge",
        amount: 50_000,
        paymentRef,
      },
      { type: "refund", amount: 50_000, paymentRef: null },
    ]);
    const [persisted] = await d
      .select({ paymentRef: bookings.paymentRef })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(persisted?.paymentRef).toBe(paymentRef);

    await expect(
      runBookingTransition(
        bookingId,
        { kind: "PAYMENT_SUCCEEDED", paymentRef },
        "stripe",
        new Date(afterDownbeat.getTime() + 2),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    const moneyAfterReplay = await d
      .select({ type: ledgerEntries.entryType })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    expect(moneyAfterReplay).toHaveLength(2);
  });

  it("rejects a success for a different provider payment without changing money or state", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userBand);
    await d
      .update(bookings)
      .set({ paymentRef: `pi_original_${bookingId}` })
      .where(eq(bookings.id, bookingId));

    await expect(
      runBookingTransition(
        bookingId,
        { kind: "PAYMENT_SUCCEEDED", paymentRef: `pi_conflict_${bookingId}` },
        "stripe",
      ),
    ).rejects.toBeInstanceOf(PaymentReferenceConflictError);

    const [unchanged] = await d
      .select({ state: bookings.state, paymentRef: bookings.paymentRef })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(unchanged).toEqual({
      state: "confirming",
      paymentRef: `pi_original_${bookingId}`,
    });
    const money = await d
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    expect(money).toHaveLength(0);
  });

  it("does not treat an arbitrary collapsed offer as a late successful charge", async () => {
    const d = db();
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_DECLINED" },
      userBand,
    );
    await d
      .update(bookings)
      .set({ paymentRef: `pi_unrelated_${bookingId}` })
      .where(eq(bookings.id, bookingId));

    await expect(
      runBookingTransition(
        bookingId,
        { kind: "PAYMENT_SUCCEEDED" },
        "stripe",
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    const money = await d
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    expect(money).toHaveLength(0);
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
    // The offer locks the VENUE's timezone into the terms. This asserted "UTC",
    // which was only ever true because the fixture had no timezone — the thing
    // worth pinning is that the room's own zone is what gets captured.
    expect(firstRow!.terms.timeZone).toBe("America/Chicago");
    expect(rivalApplication!.status).toBe("submitted");
  });

  it("rejects a second offer without taking the slot from payment confirmation", async () => {
    const { slotId, appId, rivalAppId, startsAt } =
      await makeSlotWithApplications();
    const terms = {
      amountCents: 50_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    };
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userVenue,
      terms,
    });
    await runBookingTransition(
      bookingId,
      { kind: "PERFORMER_ACCEPTED" },
      userBand,
    );

    let announceBookingLock!: () => void;
    const bookingLocked = new Promise<void>((resolve) => {
      announceBookingLock = resolve;
    });
    let releasePayment!: () => void;
    const paymentMayFillSlot = new Promise<void>((resolve) => {
      releasePayment = resolve;
    });
    const payment = runBookingTransition(
      bookingId,
      { kind: "PAYMENT_SUCCEEDED", paymentRef: `pi_lock_${bookingId}` },
      "worker",
      new Date(),
      undefined,
      {
        afterBookingLock: async () => {
          announceBookingLock();
          await paymentMayFillSlot;
        },
      },
    );
    await bookingLocked;

    let announceSlotLock!: () => void;
    const rivalReachedSlotLock = new Promise<void>((resolve) => {
      announceSlotLock = resolve;
    });
    const rivalOffer = createOffer({
      applicationId: rivalAppId,
      slotId,
      performerId: rivalPerformerId,
      venueId,
      actor: userVenue,
      terms,
      lifecycleHooks: {
        afterSlotLock: async () => announceSlotLock(),
      },
    });
    const rivalOutcome = rivalOffer.then(
      () => "offer_fulfilled" as const,
      () => "offer_rejected" as const,
    );

    // No timers: either the pre-check rejects, or the old inverted path takes
    // the slot and announces it. Holding booking while awaiting this race makes
    // the regression deterministic instead of hoping PostgreSQL schedules two
    // ordinary promises in the problematic order.
    let firstOutcome:
      | "offer_fulfilled"
      | "offer_rejected"
      | "slot_locked"
      | undefined;
    try {
      firstOutcome = await Promise.race([
        rivalOutcome,
        rivalReachedSlotLock.then(() => "slot_locked" as const),
      ]);
    } finally {
      releasePayment();
    }

    const [paymentResult, rivalResult] = await Promise.allSettled([
      payment,
      rivalOffer,
    ]);
    expect(firstOutcome).toBe("offer_rejected");
    expect(paymentResult.status).toBe("fulfilled");
    expect(rivalResult.status).toBe("rejected");
    if (rivalResult.status === "rejected")
      expect(rivalResult.reason).toBeInstanceOf(SlotUnavailableError);

    const [slot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, slotId));
    expect(slot?.status).toBe("filled");
    const [rivalApplication] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, rivalAppId));
    expect(rivalApplication?.status).toBe("declined");
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

  /**
   * A dispute resolved against the act is the ONLY way a no-show gets on an
   * act's record when the act never pressed cancel — the act played badly, or
   * didn't play, and the venue escalated. The reducer's `reliability_strike`
   * emission is unit-tested in @gigit/domain, but emitting an effect nobody
   * applies changes nothing a venue can see: the strike counter is what
   * `performerReliabilityStats` reads and what turns the /p/{id} badge from
   * "reliable" to "mixed". Deleting the runner's write leaves the emission
   * test, the ledger dispute test and the machine's property tests all green.
   *
   * A dedicated act (not the shared `performerId`, which earlier tests have
   * already struck) so the 0 → 1 step is literal rather than relative.
   */
  it("writes a performer strike when a dispute is resolved against the act", async () => {
    const d = db();
    const disputedUserId = newId("user");
    const disputedPerformerId = newId("performer");
    await d
      .insert(users)
      .values({ id: disputedUserId, email: `${disputedUserId}@t.test` });
    await d.insert(performers).values({
      id: disputedPerformerId,
      ownerUserId: disputedUserId,
      kind: "solo",
      name: "Disputed Act",
      homeMetro: "testville",
    });

    const { slotId, startsAt } = await makeSlotWithApplications();
    const disputedAppId = newId("application");
    await d
      .insert(applications)
      .values({ id: disputedAppId, slotId, performerId: disputedPerformerId });

    const [beforeAct] = await d
      .select({ s: performers.reliabilityStrikes })
      .from(performers)
      .where(eq(performers.id, disputedPerformerId));
    expect(beforeAct!.s).toBe(0);
    const [beforeVenue] = await d
      .select({ s: venues.reliabilityStrikes })
      .from(venues)
      .where(eq(venues.id, venueId));

    const bookingId = await createOffer({
      applicationId: disputedAppId,
      slotId,
      performerId: disputedPerformerId,
      venueId,
      actor: userVenue,
      terms: {
        amountCents: 50_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, disputedUserId);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    await runBookingTransition(
      bookingId,
      { kind: "DISPUTE_OPENED", openedBy: "venue", reason: "played 20 of 90 minutes" },
      userVenue,
    );
    const resolved = await runBookingTransition(
      bookingId,
      {
        kind: "DISPUTE_RESOLVED",
        resolution: { kind: "release_full", fault: "performer" },
      },
      "admin",
    );
    expect(resolved.to).toBe("released");

    const [afterAct] = await d
      .select({ s: performers.reliabilityStrikes })
      .from(performers)
      .where(eq(performers.id, disputedPerformerId));
    expect(afterAct!.s).toBe(1);
    // `against` has to be honoured, not treated as "strike somebody": the venue
    // that WON the dispute must not be marked unreliable by it.
    const [afterVenue] = await d
      .select({ s: venues.reliabilityStrikes })
      .from(venues)
      .where(eq(venues.id, venueId));
    expect(afterVenue!.s).toBe(beforeVenue!.s);

    // The two facts the /p/{id} badge is computed from, read back through the
    // real stats query and the real pure helper the page calls: one released
    // booking and one strike is exactly the "mixed" tier.
    const stats = (await performerReliabilityStats([disputedPerformerId])).get(
      disputedPerformerId,
    );
    expect(stats).toEqual({ gigsCompleted: 1, cancellations: 1 });
    expect(performerReliability(stats!)).toMatchObject({
      tier: "mixed",
      label: "1 gig played · 1 cancellation",
    });
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

  it("rejects offers to a hidden profile without changing the application", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    await db()
      .update(performers)
      .set({ status: "hidden" })
      .where(eq(performers.id, performerId));
    try {
      await expect(offerFor(slotId, appId, startsAt)).rejects.toBeInstanceOf(
        MarketplaceProfileUnavailableError,
      );
    } finally {
      await db()
        .update(performers)
        .set({ status: "live" })
        .where(eq(performers.id, performerId));
    }
    const [application] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(application?.status).toBe("submitted");
    const created = await db()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.slotId, slotId));
    expect(created).toHaveLength(0);
  });

  for (const status of ["suspended", "deleted"] as const) {
    it(`rejects offers when the performer owner is ${status}`, async () => {
      const { slotId, appId, startsAt } = await makeSlotWithApplications();
      await db()
        .update(users)
        .set({ status })
        .where(eq(users.id, userBand));
      try {
        await expect(offerFor(slotId, appId, startsAt)).rejects.toBeInstanceOf(
          AccountUnavailableError,
        );
      } finally {
        await db()
          .update(users)
          .set({ status: "active" })
          .where(eq(users.id, userBand));
      }
      const created = await db()
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.slotId, slotId));
      expect(created).toHaveLength(0);
    });
  }

  it("rejects acceptance after the venue is suspended at commit time", async () => {
    const { slotId, appId, startsAt } = await makeSlotWithApplications();
    const bookingId = await offerFor(slotId, appId, startsAt);
    await db()
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, userVenue));
    await db()
      .update(venues)
      .set({ status: "suspended" })
      .where(eq(venues.id, venueId));
    try {
      await expect(
        runBookingTransition(
          bookingId,
          { kind: "PERFORMER_ACCEPTED" },
          userBand,
        ),
      ).rejects.toBeInstanceOf(AccountUnavailableError);
    } finally {
      await db()
        .update(users)
        .set({ status: "active" })
        .where(eq(users.id, userVenue));
      await db()
        .update(venues)
        .set({ status: "live" })
        .where(eq(venues.id, venueId));
    }
    const [booking] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(booking?.state).toBe("offered");
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
