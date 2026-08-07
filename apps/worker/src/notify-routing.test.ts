import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
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

  /** Park backlog, inject events, drain, and return the notify.log_sink lines. */
  async function drainAndCaptureSinks(
    events: { kind: string; subjectType: string; subjectId: string; actor: string; payload: unknown }[],
  ) {
    await getPool().query(
      `update events set dispatched_at = now() where dispatched_at is null and dead_lettered_at is null`,
    );
    for (const e of events)
      await getPool().query(
        `insert into events (actor, kind, subject_type, subject_id, payload)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [e.actor, e.kind, e.subjectType, e.subjectId, JSON.stringify(e.payload)],
      );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainOutboxOnce(noBoss);
    const calls = spy.mock.calls.slice();
    spy.mockRestore();
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
