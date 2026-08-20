import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import {
  bookTechApplicant,
  closeDb,
  createOffer,
  createOpenSlot,
  createTechSubslot,
  db,
  getPool,
  makePerformer,
  makeTech,
  makeVenue,
  runSubslotTransition,
  schema,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { drainOutboxOnce } from "./index.js";
import { notifyUser } from "./notify.js";

/**
 * Notification delivery routing (the "log for now" gap): the OTP login code,
 * application-to-venue, and message-to-counterparty notifications were never
 * delivered. With no Twilio/SES env configured, notifyUser/notifyDestination
 * fall to a structured `notify.log_sink` line — so we drive each event through
 * the real outbox and assert the right recipient was resolved.
 */
const noBoss = {} as unknown as PgBoss;

describe("worker notification routing", () => {
  const venueOwner = newId("user");
  const bandOwner = newId("user");
  const techOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const slotId = newId("slot");
  const threadId = newId("thread");
  const otpId = newId("user");
  const applicationId = newId("application");
  const soundSlotId = newId("slot");
  const soundBookingId = newId("booking");
  const subslotId = newId("slot");
  const techId = newId("tech");
  const techApplicationId = newId("application");
  const otpDest = "login@routing.test";

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [venueOwner, bandOwner, techOwner].map((id) => ({
          id,
          email: `${id}@t.test`,
        })),
      );
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: venueOwner,
      kind: "bar",
      name: "Routing Bar",
      metro: "route-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: bandOwner,
      kind: "band",
      name: "Routing Band",
      homeMetro: "route-tv",
    });
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "route-tv",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await d.insert(schema.applications).values({ id: applicationId, slotId, performerId });
    const startsAt = new Date(Date.now() + 8 * 86_400_000);
    await d.insert(schema.slots).values({
      id: soundSlotId,
      venueId,
      metro: "route-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: soundBookingId,
      slotId: soundSlotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: techOwner,
      name: "Routing Sound Tech",
      gear: "full_rig",
    });
    await d.insert(schema.techSubslots).values({
      id: subslotId,
      bookingId: soundBookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await d.insert(schema.techSubslotApplications).values({
      id: techApplicationId,
      subslotId,
      techId,
      status: "declined",
    });
    await d.insert(schema.threads).values({ id: threadId, scope: "inquiry" });
    await d.insert(schema.threadParticipants).values([
      { threadId, userId: venueOwner },
      { threadId, userId: bandOwner },
    ]);
    await d.insert(schema.authOtps).values({
      id: otpId,
      destination: otpDest,
      code: "424242",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  /**
   * Mark everything already queued as dispatched so a drain observes only the
   * rows this test is responsible for. Split out of `drainAndCaptureSinks`
   * because the producer-driven cases below cannot inject their own row: they
   * have to park FIRST, then call the real producer, then drain.
   */
  async function parkOutboxBacklog() {
    await getPool().query(
      `update events set dispatched_at = now() where dispatched_at is null and dead_lettered_at is null`,
    );
  }

  /** Drain whatever is pending and return the notify.log_sink lines it wrote. */
  async function captureDrainSinks(boss: PgBoss = noBoss) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls: unknown[][] = [];
    try {
      await drainOutboxOnce(boss);
    } finally {
      // Copy before restoring: mockRestore drops the recorded calls with the
      // spy, so reading them afterwards yields an empty (silently passing) list.
      calls = spy.mock.calls.slice();
      spy.mockRestore();
    }
    return calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.kind === "notify.log_sink");
  }

  /** Park backlog, inject events, drain, and return the notify.log_sink lines. */
  async function drainAndCaptureSinks(
    events: { kind: string; subjectType: string; subjectId: string; actor: string; payload: unknown }[],
  ) {
    await parkOutboxBacklog();
    for (const e of events)
      await getPool().query(
        `insert into events (actor, kind, subject_type, subject_id, payload)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [e.actor, e.kind, e.subjectType, e.subjectId, JSON.stringify(e.payload)],
      );
    return captureDrainSinks();
  }

  const notify = (template: string, to: string, extra: Record<string, unknown> = {}) => ({
    ...extra,
    effects: [{ kind: "notify", template, to }],
  });

  it("sends an application decline to the act, not the venue that declined it", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "application.declined",
        subjectType: "slot",
        subjectId: slotId,
        actor: venueOwner,
        payload: notify("application_declined", "performer", { applicationId }),
      },
    ]);
    // Every slot-subject notify used to resolve to the venue owner, so the one
    // party who needed the news — the act — was the one who never got it.
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: bandOwner, template: "application_declined" }),
    );
    expect(sinks.some((s) => s.userId === venueOwner)).toBe(false);
  });

  it("tells the act when its application closed because the gig date passed", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "application.declined",
        subjectType: "slot",
        subjectId: slotId,
        actor: "system",
        payload: notify("application_expired", "performer", {
          applicationId,
          reason: "slot_expired",
        }),
      },
    ]);
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: bandOwner,
        template: "application_expired",
        subject: "That gig date has passed",
      }),
    );
    expect(sinks.some((s) => s.userId === venueOwner)).toBe(false);
  });

  it("uses truthful copy when an application is declined or its date is cancelled", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "application.declined",
        subjectType: "slot",
        subjectId: slotId,
        actor: venueOwner,
        payload: notify("application_not_selected", "performer", {
          applicationId,
          reason: "venue_declined",
        }),
      },
      {
        kind: "application.declined",
        subjectType: "slot",
        subjectId: slotId,
        actor: venueOwner,
        payload: notify("application_cancelled", "performer", {
          applicationId,
          reason: "slot_cancelled",
        }),
      },
    ]);
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: bandOwner,
        template: "application_not_selected",
        subject: "The venue passed on your application",
      }),
    );
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: bandOwner,
        template: "application_cancelled",
        subject: "That gig date was cancelled",
      }),
    );
    expect(
      sinks
        .filter(
          (sink) =>
            sink.template === "application_not_selected" ||
            sink.template === "application_cancelled",
        )
        .some((sink) => sink.userId === venueOwner),
    ).toBe(false);
  });

  it("re-checks account status at the final notification boundary", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const status of ["suspended", "deleted"] as const) {
        const inactiveUser = newId("user");
        await db().insert(schema.users).values({
          id: inactiveUser,
          email: `${inactiveUser}@t.test`,
          status,
        });
        await notifyUser(inactiveUser, "slot_match", { slotId });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("delivers only the exact essential suspension event to a suspended account", async () => {
    const suspendedUser = newId("user");
    await db().insert(schema.users).values({
      id: suspendedUser,
      email: `${suspendedUser}@t.test`,
      status: "suspended",
    });

    const sinks = await drainAndCaptureSinks([
      {
        kind: "user.suspended",
        subjectType: "user",
        subjectId: suspendedUser,
        actor: venueOwner,
        // Legacy status-only rows must not claim commitments were wound down.
        payload: {},
      },
      {
        kind: "user.active",
        subjectType: "user",
        subjectId: suspendedUser,
        actor: venueOwner,
        // A marker on any other event is not an essential-delivery bypass.
        payload: { commitmentsWoundDown: true },
      },
      {
        kind: "user.suspended",
        subjectType: "user",
        subjectId: suspendedUser,
        actor: venueOwner,
        payload: { commitmentsWoundDown: true },
      },
    ]);
    expect(sinks).toEqual([
      expect.objectContaining({
        userId: suspendedUser,
        template: "account_suspended",
        subject: "Your EightGig account was suspended",
      }),
    ]);

    await db()
      .update(schema.users)
      .set({ status: "deleted" })
      .where(eq(schema.users.id, suspendedUser));
    const afterDeletion = await drainAndCaptureSinks([
      {
        kind: "user.suspended",
        subjectType: "user",
        subjectId: suspendedUser,
        actor: venueOwner,
        payload: { commitmentsWoundDown: true },
      },
    ]);
    expect(afterDeletion).toEqual([]);
  });

  it("backfills a missing booking conversation from booking.offered", async () => {
    await getPool().query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
    await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ($1, 'booking.offered', 'booking', $2, '{}'::jsonb)`,
      [venueOwner, soundBookingId],
    );
    await drainOutboxOnce(noBoss);

    const { rows } = await getPool().query(
      `select t.id, array_agg(tp.user_id order by tp.user_id) as participants
         from threads t
         join thread_participants tp on tp.thread_id = t.id
        where t.scope = 'booking' and t.subject_id = $1
        group by t.id`,
      [soundBookingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].participants).toEqual([venueOwner, bandOwner].sort());
  });

  it("routes OTP, application, and message notifications to the right recipients", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "auth.otp_requested",
        subjectType: "auth",
        subjectId: otpDest,
        actor: "system",
        payload: notify("otp", "both", { otpId }),
      },
      {
        kind: "slot.application",
        subjectType: "slot",
        subjectId: slotId,
        actor: bandOwner,
        payload: notify("new_application", "venue"),
      },
      {
        kind: "message.sent",
        subjectType: "thread",
        subjectId: threadId,
        actor: venueOwner, // the sender — must NOT be notified
        payload: notify("new_message", "both"),
      },
    ]);

    // OTP → delivered to the raw destination (signup may have no user row yet)
    expect(sinks).toContainEqual(
      expect.objectContaining({ destination: otpDest, template: "otp" }),
    );
    // application → the slot's venue owner
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: venueOwner, template: "new_application" }),
    );
    // message → the other participant only, never the sender
    const msgRecipients = sinks
      .filter((s) => s.template === "new_message")
      .map((s) => s.userId);
    expect(msgRecipients).toEqual([bandOwner]);
  });

  it("routes sound application arrival and both outcomes to the right people", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "subslot.application",
        subjectType: "tech_subslot",
        subjectId: subslotId,
        actor: techOwner,
        payload: notify("subslot_new_application", "payer", {
          applicationId: techApplicationId,
        }),
      },
      {
        kind: "subslot.application_declined",
        subjectType: "tech_subslot",
        subjectId: subslotId,
        actor: venueOwner,
        payload: notify("subslot_application_declined", "applicant", {
          applicationId: techApplicationId,
          reason: "another_tech_booked",
        }),
      },
      {
        kind: "subslot.application_declined",
        subjectType: "tech_subslot",
        subjectId: subslotId,
        actor: "worker",
        payload: notify("subslot_application_cancelled", "applicant", {
          applicationId: techApplicationId,
          reason: "sound_job_closed",
        }),
      },
    ]);
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: venueOwner,
        template: "subslot_new_application",
        subject: "A sound tech applied",
      }),
    );
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: techOwner,
        template: "subslot_application_declined",
        subject: "That sound job went to another tech",
      }),
    );
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: techOwner,
        template: "subslot_application_cancelled",
        subject: "That sound job closed",
      }),
    );
  });

  it("welcomes the act's own owner when a performer profile is created", async () => {
    const sinks = await drainAndCaptureSinks([
      {
        kind: "performer.created",
        subjectType: "performer",
        subjectId: performerId,
        actor: bandOwner,
        payload: { foundingNumber: 1, foundingMember: true },
      },
    ]);
    // performer.created only ever fanned OUT to venues, so the person who just
    // built the profile was the one party the event never reached.
    expect(sinks).toContainEqual(
      expect.objectContaining({
        userId: bandOwner,
        template: "act_welcome",
        subject: "Your act page is live",
      }),
    );
  });

  /**
   * The cases above inject the outbox row themselves, which proves routing but
   * leaves the emitting side unjoined: nothing checks that any producer ever
   * writes a row of that shape. The three below drive the REAL producer
   * (`createOffer`, `bookTechApplicant`, `createOpenSlot`) and then drain, so a
   * changed event kind, subject type or effect target breaks them — which is
   * exactly how "the act is never told it has an offer" would ship green today.
   */
  it("tells the act, and only the act, about an offer the real createOffer path made", async () => {
    const venue = await makeVenue({ name: "Offer Room", metro: "route-offer" });
    const act = await makePerformer({ name: "Offer Act", homeMetro: "route-offer" });
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    const offerSlotId = newId("slot");
    await db().insert(schema.slots).values({
      id: offerSlotId,
      venueId: venue.id,
      metro: "route-offer",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    const offerApplicationId = newId("application");
    await db()
      .insert(schema.applications)
      .values({ id: offerApplicationId, slotId: offerSlotId, performerId: act.id });

    await parkOutboxBacklog();
    const bookingId = await createOffer({
      applicationId: offerApplicationId,
      slotId: offerSlotId,
      performerId: act.id,
      venueId: venue.id,
      actor: venue.ownerUserId,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 120 * 60_000).toISOString(),
      },
    });
    // `offerCreatedEffects` also arms the expiry timer, so the drain needs a
    // boss: with the bare `{}` stub the schedule effect throws and the notify
    // that follows it in the same row never runs.
    const send = vi.fn(async () => null);
    const sinks = await captureDrainSinks({ send } as unknown as PgBoss);

    // The venue just made the offer; "You got an offer" is news for the act
    // alone. A `to:"venue"`/`to:"both"` slip here is silent — the booking exists
    // either way, and the act simply never hears about it until the offer expires.
    expect(sinks.filter((s) => s.template === "offer_received").map((s) => s.userId)).toEqual([
      act.ownerUserId,
    ]);
    // Same produced row, other effect: the offer must not be able to outlive
    // its own TTL because nobody armed the timer.
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ bookingId }),
      expect.objectContaining({ singletonKey: `${bookingId}:offer_expiry` }),
    );
  });

  it("tells both the payer and the booked tech when bookTechApplicant fills a sound job", async () => {
    const venue = await makeVenue({ name: "Sound Room", metro: "route-sound" });
    const act = await makePerformer({ name: "Sound Act", homeMetro: "route-sound" });
    const tech = await makeTech({ name: "Booked Sound Tech" });
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    const soundSlot = newId("slot");
    const parentBooking = newId("booking");
    const filledSubslot = newId("slot");
    await db().insert(schema.slots).values({
      id: soundSlot,
      venueId: venue.id,
      metro: "route-sound",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: parentBooking,
      slotId: soundSlot,
      performerId: act.id,
      venueId: venue.id,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    await db().insert(schema.techSubslots).values({
      id: filledSubslot,
      bookingId: parentBooking,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(schema.techSubslotApplications).values({
      id: newId("application"),
      subslotId: filledSubslot,
      techId: tech.id,
    });

    await parkOutboxBacklog();
    await bookTechApplicant({
      subslotId: filledSubslot,
      techId: tech.id,
      actor: venue.ownerUserId,
    });
    const sinks = await captureDrainSinks();

    // `to:"both"` is the only target that reaches the tech, and the tech-owner
    // half needs a second lookup through techs.owner_user_id — so a decayed
    // `to:"payer"` (or a broken lookup) leaves the person who just got the job
    // as the only party who doesn't know. Exact array: payer first, tech second.
    expect(sinks.filter((s) => s.template === "subslot_booked").map((s) => s.userId)).toEqual([
      venue.ownerUserId,
      tech.ownerUserId,
    ]);
  });

  /**
   * The consent gate is only a gate if the person being asked to pay hears
   * about it. A proposal nobody is told about does not protect the payer — it
   * just means the sound job silently never opens, and the act waits on an
   * answer that was never requested.
   *
   * Driven through the real create path, because the notify effect is written
   * by createTechSubslot itself: an assertion against a hand-written event
   * would still pass if that producer stopped emitting one.
   */
  it("tells the venue when an act posts a sound job on the venue's tab", async () => {
    const venue = await makeVenue({ name: "Proposal Room", metro: "route-proposal" });
    const act = await makePerformer({
      name: "Proposal Act",
      homeMetro: "route-proposal",
    });
    const startsAt = new Date(Date.now() + 21 * 86_400_000);
    const proposalSlot = newId("slot");
    const proposalBooking = newId("booking");
    await db().insert(schema.slots).values({
      id: proposalSlot,
      venueId: venue.id,
      metro: "route-proposal",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: proposalBooking,
      slotId: proposalSlot,
      performerId: act.id,
      venueId: venue.id,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });

    await parkOutboxBacklog();
    const proposedSubslot = await createTechSubslot({
      bookingId: proposalBooking,
      payer: "venue",
      budgetCents: 15_000,
      actor: act.ownerUserId,
    });
    const sinks = await captureDrainSinks();

    const proposals = sinks.filter((s) => s.template === "subslot_proposed");
    // Only the payer: telling the act it has been asked to pay for its own ask
    // is noise, and telling nobody is the silence this exists to fix.
    expect(proposals.map((s) => s.userId)).toEqual([venue.ownerUserId]);
    expect(proposals[0].subject).toBe("Someone's asking you to cover sound");

    // And the payer accepting routes back the other way, to the act that asked.
    await parkOutboxBacklog();
    await runSubslotTransition(
      proposedSubslot,
      { kind: "PAYER_ACCEPTED" },
      venue.ownerUserId,
    );
    const acceptance = await captureDrainSinks();
    expect(
      acceptance
        .filter((s) => s.template === "subslot_proposal_accepted")
        .map((s) => s.userId),
    ).toEqual([act.ownerUserId]);
  });

  it("sends a decline to the side that proposed it, never back to the payer", async () => {
    // "proposer" is derived — it is whichever party is NOT the payer — so a
    // lookup that fell back to the payer would mail the decline to the person
    // who wrote it and tell the act nothing at all.
    const sinks = await drainAndCaptureSinks([
      {
        kind: "subslot.transition",
        subjectType: "tech_subslot",
        subjectId: subslotId,
        actor: venueOwner,
        payload: notify("subslot_proposal_declined", "proposer"),
      },
    ]);
    const declines = sinks.filter(
      (s) => s.template === "subslot_proposal_declined",
    );
    // The fixture sub-slot is payer:"venue", so the act is the proposer.
    expect(declines.map((s) => s.userId)).toEqual([bandOwner]);
  });

  it("alerts a saved-search subscriber about a slot the real create path posted", async () => {
    // A fresh metro per run: the database persists between runs, so a fixed one
    // would let a previous run's saved searches match this slot too.
    const metro = `route-saved-search-${Date.now()}`;
    const venue = await makeVenue({ name: "Alert Room", metro });
    const watcher = await makePerformer({ name: "Watching Act", homeMetro: metro });
    const priced = await makePerformer({ name: "Pricier Act", homeMetro: metro });
    await db().insert(schema.savedSearches).values([
      {
        id: newId("search"),
        performerId: watcher.id,
        format: "music",
        metro,
        minBudgetCents: 20_000,
      },
      {
        id: newId("search"),
        performerId: priced.id,
        format: "music",
        metro,
        minBudgetCents: 90_000,
      },
    ]);

    await parkOutboxBacklog();
    await createOpenSlot({
      venueId: venue.id,
      actor: venue.ownerUserId,
      startsAt: new Date(Date.now() + 10 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      genrePrefs: [],
      budgetCents: 30_000,
      provides: {},
      source: "web",
    });
    const sinks = await captureDrainSinks();

    // slot.created carries no `effects`, so this alert lives in a kind-matched
    // branch of the dispatcher rather than the effect loop: rename the kind on
    // either side and acts stop hearing about new gigs with nothing to show it.
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: watcher.ownerUserId, template: "slot_match" }),
    );
    // ...and it is the saved search being consulted, not a blanket fan-out: this
    // act's floor is above the posted budget.
    expect(sinks.some((s) => s.userId === priced.ownerUserId)).toBe(false);
  });

  it("does not welcome an act whose owner is no longer active", async () => {
    const suspendedOwner = newId("user");
    const suspendedPerformer = newId("performer");
    await db().insert(schema.users).values({
      id: suspendedOwner,
      email: `${suspendedOwner}@t.test`,
      status: "suspended",
    });
    await db().insert(schema.performers).values({
      id: suspendedPerformer,
      ownerUserId: suspendedOwner,
      kind: "band",
      name: "Suspended Band",
      homeMetro: "route-tv",
    });

    const sinks = await drainAndCaptureSinks([
      {
        kind: "performer.created",
        subjectType: "performer",
        subjectId: suspendedPerformer,
        actor: suspendedOwner,
        payload: { foundingNumber: 2, foundingMember: true },
      },
    ]);
    // The outbox row can outlive the account: a profile created and then
    // suspended must not get an onboarding nudge to a page it can no longer use.
    expect(sinks.some((s) => s.userId === suspendedOwner)).toBe(false);
    expect(sinks.some((s) => s.template === "act_welcome")).toBe(false);
  });
});
