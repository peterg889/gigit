import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { AccountUnavailableError } from "./account-gate.js";
import { suspendAccount } from "./account.js";
import { closeDb, db } from "./client.js";
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

const DAY = 86_400_000;
const HOUR = 3_600_000;
const actionableStates = ["offered", "confirming", "confirmed"] as const;
const retainedStates = ["awaiting_confirmation", "disputed"] as const;
const matrixStates = [...actionableStates, ...retainedStates] as const;

describe("account suspension lifecycle", () => {
  afterAll(async () => {
    await closeDb();
  });

  async function seedBooking(input: {
    performerId: string;
    venueId: string;
    state: (typeof matrixStates)[number];
    startsAt: Date;
    paymentRef?: string;
  }) {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const holdsFilledDate = retainedStates.includes(
      input.state as (typeof retainedStates)[number],
    ) || input.state === "confirmed";
    await db().insert(slots).values({
      id: slotId,
      venueId: input.venueId,
      metro: "suspension-matrix",
      startsAt: input.startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: holdsFilledDate ? "filled" : "open",
    });
    await db().insert(bookings).values({
      id: bookingId,
      slotId,
      performerId: input.performerId,
      venueId: input.venueId,
      state: input.state,
      terms: {
        amountCents: 30_000,
        startsAt: input.startsAt.toISOString(),
        endsAt: new Date(input.startsAt.getTime() + 2 * HOUR).toISOString(),
      },
      offerExpiresAt: new Date(input.startsAt.getTime() - DAY),
      paymentRef: input.paymentRef,
      ...(input.state !== "offered" ? { performerAcceptedAt: new Date() } : {}),
    });
    return { bookingId, slotId };
  }

  it("winds every actionable performer and venue commitment while retaining post-gig and disputed records", async () => {
    const adminId = await makeUser();
    const targetUserId = newId("user");
    const targetEmail = `${targetUserId}@suspension-matrix.test`;
    await makeUser({ id: targetUserId, email: targetEmail });
    const targetPerformer = await makePerformer({
      ownerUserId: targetUserId,
      name: "Suspension Matrix Act",
    });
    const targetVenue = await makeVenue({
      ownerUserId: targetUserId,
      name: "Suspension Matrix Room",
    });
    const otherPerformer = await makePerformer({ name: "Matrix Counterparty Act" });
    const otherVenue = await makeVenue({ name: "Matrix Counterparty Room" });

    const byRole = {
      performer: [] as Array<{
        state: (typeof matrixStates)[number];
        bookingId: string;
        slotId: string;
      }>,
      venue: [] as Array<{
        state: (typeof matrixStates)[number];
        bookingId: string;
        slotId: string;
      }>,
    };
    for (const [index, state] of matrixStates.entries()) {
      byRole.performer.push({
        state,
        ...(await seedBooking({
          performerId: targetPerformer.id,
          venueId: otherVenue.id,
          state,
          startsAt: new Date(Date.now() + (30 + index * 2) * DAY),
        })),
      });
      byRole.venue.push({
        state,
        ...(await seedBooking({
          performerId: otherPerformer.id,
          venueId: targetVenue.id,
          state,
          startsAt: new Date(Date.now() + (31 + index * 2) * DAY),
        })),
      });
    }

    const performerApplicationSlot = newId("slot");
    const performerApplicationId = newId("application");
    await db().insert(slots).values({
      id: performerApplicationSlot,
      venueId: otherVenue.id,
      metro: "suspension-matrix",
      startsAt: new Date(Date.now() + 50 * DAY),
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
    });
    await db().insert(applications).values({
      id: performerApplicationId,
      slotId: performerApplicationSlot,
      performerId: targetPerformer.id,
    });

    const venueOpenSlot = newId("slot");
    const venueApplicationId = newId("application");
    await db().insert(slots).values({
      id: venueOpenSlot,
      venueId: targetVenue.id,
      metro: "suspension-matrix",
      startsAt: new Date(Date.now() + 51 * DAY),
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
    });
    await db().insert(applications).values({
      id: venueApplicationId,
      slotId: venueOpenSlot,
      performerId: otherPerformer.id,
    });

    const seriesId = newId("series");
    const seriesSlotId = newId("slot");
    await db().insert(slotSeries).values({
      id: seriesId,
      venueId: targetVenue.id,
      metro: "suspension-matrix",
      pattern: {
        freq: "weekly",
        dayOfWeek: 5,
        startTimeLocal: "20:00",
        timeZone: "America/Chicago",
        durationMinutes: 120,
      },
      defaults: {
        format: "music",
        genrePrefs: [],
        budgetCents: 25_000,
        provides: {},
      },
    });
    await db().insert(slots).values({
      id: seriesSlotId,
      venueId: targetVenue.id,
      seriesId,
      metro: "suspension-matrix",
      startsAt: new Date(Date.now() + 52 * DAY),
      durationMinutes: 120,
      format: "music",
      budgetCents: 25_000,
    });

    expect(await suspendAccount(targetUserId, adminId)).toBe("updated");

    const expectedState = (
      role: "performer" | "venue",
      state: (typeof matrixStates)[number],
    ) => {
      if (state === "offered" || state === "confirming") return "collapsed";
      if (state === "confirmed")
        return role === "performer"
          ? "cancelled_by_performer"
          : "cancelled_by_venue";
      return state;
    };
    for (const role of ["performer", "venue"] as const) {
      for (const seeded of byRole[role]) {
        const [booking] = await db()
          .select({ state: bookings.state })
          .from(bookings)
          .where(eq(bookings.id, seeded.bookingId));
        expect(booking?.state, `${role}:${seeded.state}`).toBe(
          expectedState(role, seeded.state),
        );
        const [slot] = await db()
          .select({ status: slots.status })
          .from(slots)
          .where(eq(slots.id, seeded.slotId));
        const expectedSlot = retainedStates.includes(
          seeded.state as (typeof retainedStates)[number],
        )
          ? "filled"
          : role === "venue"
            ? "cancelled"
            : "open";
        expect(slot?.status, `${role}:${seeded.state}:slot`).toBe(expectedSlot);
      }
    }

    const [targetApplication] = await db()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, performerApplicationId));
    expect(targetApplication?.status).toBe("withdrawn");
    const [venueApplication] = await db()
      .select({
        status: applications.status,
        reason: applications.declineReason,
      })
      .from(applications)
      .where(eq(applications.id, venueApplicationId));
    expect(venueApplication).toEqual({
      status: "declined",
      reason: "slot_cancelled",
    });
    const [openSlot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, venueOpenSlot));
    const [series] = await db()
      .select({ status: slotSeries.status })
      .from(slotSeries)
      .where(eq(slotSeries.id, seriesId));
    const [seriesSlot] = await db()
      .select({ status: slots.status })
      .from(slots)
      .where(eq(slots.id, seriesSlotId));
    expect(openSlot?.status).toBe("cancelled");
    expect(series?.status).toBe("cancelled");
    expect(seriesSlot?.status).toBe("cancelled");

    const [user] = await db()
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, targetUserId));
    const [performer] = await db()
      .select({ status: performers.status })
      .from(performers)
      .where(eq(performers.id, targetPerformer.id));
    const [venue] = await db()
      .select({ status: venues.status })
      .from(venues)
      .where(eq(venues.id, targetVenue.id));
    expect(user).toEqual({
      status: "suspended",
      email: targetEmail,
    });
    expect(performer?.status).toBe("suspended");
    expect(venue?.status).toBe("suspended");

    const confirmingIds = [
      byRole.performer.find((row) => row.state === "confirming")!.bookingId,
      byRole.venue.find((row) => row.state === "confirming")!.bookingId,
    ];
    const confirmingHistory = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(inArray(events.subjectId, confirmingIds));
    expect(confirmingHistory).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            event: "PAYMENT_FAILED",
            reason: "account_suspended",
          }),
        },
      ]),
    );
    const confirmedHistory = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(
        eq(
          events.subjectId,
          byRole.performer.find((row) => row.state === "confirmed")!.bookingId,
        ),
      );
    expect(confirmedHistory).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            effects: expect.arrayContaining([
              expect.objectContaining({ kind: "notify" }),
            ]),
          }),
        },
      ]),
    );
    const [suspensionEvent] = await db()
      .select({ actor: events.actor, payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, targetUserId));
    expect(suspensionEvent).toEqual({
      actor: adminId,
      payload: expect.objectContaining({ commitmentsWoundDown: true }),
    });
  });

  it("reopens future sound work, withdraws pending applications, and preserves post-downbeat assignments", async () => {
    const adminId = await makeUser();
    const targetUserId = newId("user");
    const targetEmail = `${targetUserId}@suspension-tech.test`;
    await makeUser({ id: targetUserId, email: targetEmail });
    const techId = newId("tech");
    await db().insert(techs).values({
      id: techId,
      ownerUserId: targetUserId,
      name: "Suspended Sound Tech",
      gear: "full_rig",
    });
    const venue = await makeVenue({ name: "Sound Suspension Room" });
    const performer = await makePerformer({ name: "Sound Suspension Act" });

    const futureBooking = await seedBooking({
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      startsAt: new Date(Date.now() + 20 * DAY),
    });
    const futureSubslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: futureSubslotId,
      bookingId: futureBooking.bookingId,
      payer: "venue",
      budgetCents: 10_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
      techId,
      state: "booked",
    });

    const applicationBooking = await seedBooking({
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      startsAt: new Date(Date.now() + 22 * DAY),
    });
    const applicationSubslotId = newId("slot");
    const techApplicationId = newId("application");
    await db().insert(techSubslots).values({
      id: applicationSubslotId,
      bookingId: applicationBooking.bookingId,
      payer: "venue",
      budgetCents: 8_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(techSubslotApplications).values({
      id: techApplicationId,
      subslotId: applicationSubslotId,
      techId,
    });

    const pastBooking = await seedBooking({
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      startsAt: new Date(Date.now() - DAY),
    });
    const pastSubslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: pastSubslotId,
      bookingId: pastBooking.bookingId,
      payer: "venue",
      budgetCents: 9_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
      techId,
      state: "booked",
    });

    expect(await suspendAccount(targetUserId, adminId)).toBe("updated");

    const [future] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, futureSubslotId));
    const [past] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, pastSubslotId));
    expect(future).toEqual({ state: "open", techId: null });
    expect(past).toEqual({ state: "booked", techId });
    expect(
      await db()
        .select({ id: techSubslotApplications.id })
        .from(techSubslotApplications)
        .where(eq(techSubslotApplications.id, techApplicationId)),
    ).toHaveLength(0);
    const [tech] = await db()
      .select({ status: techs.status })
      .from(techs)
      .where(eq(techs.id, techId));
    const [user] = await db()
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, targetUserId));
    expect(tech?.status).toBe("suspended");
    expect(user).toEqual({
      status: "suspended",
      email: targetEmail,
    });
  });

  it("compensates a payment success that arrives after suspension collapsed confirming", async () => {
    const adminId = await makeUser();
    const targetUserId = await makeUser();
    const performer = await makePerformer({
      ownerUserId: targetUserId,
      name: "Suspended Confirming Act",
    });
    const venue = await makeVenue({ name: "Suspended Confirming Room" });
    const paymentRef = `pi_suspend_${newId("booking")}`;
    const seeded = await seedBooking({
      performerId: performer.id,
      venueId: venue.id,
      state: "confirming",
      startsAt: new Date(Date.now() + 25 * DAY),
      paymentRef,
    });

    await suspendAccount(targetUserId, adminId);
    await runBookingTransition(
      seeded.bookingId,
      { kind: "PAYMENT_SUCCEEDED", paymentRef },
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

  it("repairs lingering commitments on a legacy suspended account exactly once", async () => {
    const adminId = await makeUser();
    const targetUserId = newId("user");
    await db().insert(users).values({
      id: targetUserId,
      email: `${targetUserId}@legacy-suspended.test`,
      status: "suspended",
    });
    const performer = await makePerformer({
      ownerUserId: targetUserId,
      name: "Legacy Suspended Act",
      status: "suspended",
    });
    const venue = await makeVenue({ name: "Legacy Suspension Room" });
    const seeded = await seedBooking({
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      startsAt: new Date(Date.now() + 26 * DAY),
    });

    expect(await suspendAccount(targetUserId, adminId)).toBe("updated");
    const [booking] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, seeded.bookingId));
    expect(booking?.state).toBe("cancelled_by_performer");
    const repairEvents = await db()
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.subjectId, targetUserId));
    expect(repairEvents).toEqual([
      {
        payload: expect.objectContaining({
          commitmentsWoundDown: true,
          repaired: true,
        }),
      },
    ]);

    expect(await suspendAccount(targetUserId, adminId)).toBe("unchanged");
    expect(
      await db()
        .select({ id: events.id })
        .from(events)
        .where(eq(events.subjectId, targetUserId)),
    ).toHaveLength(1);
  });

  it("sweeps work committed before the account gate and rejects work after suspension", async () => {
    const adminId = await makeUser();
    const venue = await makeVenue({ name: "Suspension Gate Room" });
    const performer = await makePerformer({ name: "Suspension Gate Act" });
    const startsAt = new Date(Date.now() + 27 * DAY);
    const terms = {
      amountCents: 24_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * HOUR).toISOString(),
    };
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "suspension-gate",
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
    const suspension = suspendAccount(performer.ownerUserId, adminId);
    releaseGate();
    const bookingId = await offer;
    await suspension;

    const [swept] = await db()
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(swept?.state).toBe("collapsed");

    const laterStartsAt = new Date(startsAt.getTime() + DAY);
    const laterSlotId = newId("slot");
    const laterApplicationId = newId("application");
    await db().insert(slots).values({
      id: laterSlotId,
      venueId: venue.id,
      metro: "suspension-gate",
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
          endsAt: new Date(laterStartsAt.getTime() + 2 * HOUR).toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(AccountUnavailableError);
  });
});
