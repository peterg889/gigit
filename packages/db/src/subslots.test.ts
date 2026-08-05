import { ACTIVE_SUBSLOT_STATES, newId } from "@gigit/domain";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { createOffer, runBookingTransition } from "./transition.js";
import {
  applyToOpenTechSubslot,
  bookTechApplicant,
  cascadeParentToSubslots,
  createTechSubslot,
  runSubslotTransition,
  TechSubslotAlreadyActiveError,
  TechSubslotApplicationError,
  TechSubslotParentUnavailableError,
  TechUnavailableError,
  withdrawTechSubslotApplication,
} from "./subslots.js";
import { bookingLedger } from "./ledger.js";
import {
  applications,
  bookings,
  events,
  ledgerEntries,
  performers,
  slots,
  techs,
  techSubslotApplications,
  techSubslots,
  users,
  venues,
} from "./schema.js";

/** Full sub-slot lifecycle against real Postgres — the money must balance. */
describe("tech sub-slot runner (integration)", () => {
  const userV = newId("user");
  const userP = newId("user");
  const userT = newId("user");
  const userT2 = newId("user");
  const userT3 = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");
  const techId2 = newId("tech");
  const techId3 = newId("tech");
  // gig 36h out → payer cancellation lands in the 48h–14d window? No: <48h = 100%.
  const gigStart = new Date(Date.now() + 36 * 3_600_000);
  const gigEnd = new Date(gigStart.getTime() + 2 * 3_600_000);
  let bookingId: string;
  let subslotId: string;

  async function seedConfirmedBooking(
    startsAt = new Date(Date.now() + 14 * 86_400_000),
  ): Promise<string> {
    const slotId = newId("slot");
    const seededBookingId = newId("booking");
    await db().insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(bookings).values({
      id: seededBookingId,
      slotId,
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
    return seededBookingId;
  }

  async function seedOpenTechJob(
    startsAt: Date,
    candidateTechId: string,
  ): Promise<{ bookingId: string; subslotId: string }> {
    const seededBookingId = await seedConfirmedBooking(startsAt);
    const seededSubslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: seededSubslotId,
      bookingId: seededBookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(techSubslotApplications).values({
      id: newId("application"),
      subslotId: seededSubslotId,
      techId: candidateTechId,
    });
    return { bookingId: seededBookingId, subslotId: seededSubslotId };
  }

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: userV, email: `${userV}@t.test` },
      { id: userP, email: `${userP}@t.test` },
      { id: userT, email: `${userT}@t.test` },
      { id: userT2, email: `${userT2}@t.test` },
      { id: userT3, email: `${userT3}@t.test` },
    ]);
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: userV,
      kind: "bar",
      name: "Subslot Test Bar",
      metro: "testville",
      lat: 43,
      lng: -87.9,
      paInventory: { hasPA: false },
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: userP,
      kind: "band",
      name: "Subslot Test Band",
      homeMetro: "testville",
      techNeeds: { inputs: 8 },
    });
    await d.insert(techs).values([
      {
        id: techId,
        ownerUserId: userT,
        name: "Subslot Test Tech",
        gear: "full_rig",
      },
      {
        id: techId2,
        ownerUserId: userT2,
        name: "Second Subslot Test Tech",
        gear: "partial",
      },
      {
        id: techId3,
        ownerUserId: userT3,
        name: "Never Applied Test Tech",
        gear: "none",
      },
    ]);
    const slotId = newId("slot");
    await d.insert(slots).values({
      id: slotId,
      venueId,
      metro: "testville",
      startsAt: gigStart,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
    });
    const appId = newId("application");
    await d.insert(applications).values({ id: appId, slotId, performerId });
    bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: userV,
      terms: {
        amountCents: 40_000,
        startsAt: gigStart.toISOString(),
        endsAt: gigEnd.toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, userP);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "test");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates the sub-slot with the sound-plan snapshot from real profiles", async () => {
    subslotId = await createTechSubslot({
      bookingId,
      payer: "venue",
      budgetCents: 25_000,
      actor: userV,
      notes: "loud room",
    });
    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.state).toBe("open");
    expect(s.needs.verdict).toBe("tech_and_rig_needed"); // no PA × 8 inputs
    expect(s.needs.inputs).toBe(8);
  });

  it("allows exactly one concurrent active sound job and emits one creation event", async () => {
    const concurrentBookingId = await seedConfirmedBooking();
    const results = await Promise.allSettled([
      createTechSubslot({
        bookingId: concurrentBookingId,
        payer: "venue",
        budgetCents: 12_000,
        actor: userV,
      }),
      createTechSubslot({
        bookingId: concurrentBookingId,
        payer: "performer",
        budgetCents: 13_000,
        actor: userP,
      }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TechSubslotAlreadyActiveError);

    const active = await db()
      .select({ id: techSubslots.id })
      .from(techSubslots)
      .where(
        and(
          eq(techSubslots.bookingId, concurrentBookingId),
          inArray(techSubslots.state, ACTIVE_SUBSLOT_STATES),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(fulfilled[0]!.value);
    const creationEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectId, active[0]!.id),
          eq(events.kind, "subslot.created"),
        ),
      );
    expect(creationEvents).toHaveLength(1);
  });

  it("rejects positive interval overlap but allows exact end/start adjacency", async () => {
    const firstStart = new Date(Date.now() + 60 * 86_400_000);
    const first = await seedOpenTechJob(firstStart, techId3);
    const overlap = await seedOpenTechJob(
      new Date(firstStart.getTime() + 60 * 60_000),
      techId3,
    );
    const adjacent = await seedOpenTechJob(
      new Date(firstStart.getTime() + 2 * 60 * 60_000),
      techId3,
    );

    await bookTechApplicant({
      subslotId: first.subslotId,
      techId: techId3,
      actor: userV,
    });
    await expect(
      bookTechApplicant({
        subslotId: overlap.subslotId,
        techId: techId3,
        actor: userV,
      }),
    ).rejects.toMatchObject<TechUnavailableError>({
      code: "tech_unavailable",
      techId: techId3,
      conflictingSubslotId: first.subslotId,
    });

    const [rolledBackJob] = await db()
      .select({ state: techSubslots.state })
      .from(techSubslots)
      .where(eq(techSubslots.id, overlap.subslotId));
    const [rolledBackApplication] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.subslotId, overlap.subslotId));
    expect(rolledBackJob?.state).toBe("open");
    expect(rolledBackApplication?.status).toBe("submitted");

    await expect(
      bookTechApplicant({
        subslotId: adjacent.subslotId,
        techId: techId3,
        actor: userV,
      }),
    ).resolves.toMatchObject({ to: "booked" });
  });

  it("serializes concurrent overlapping selections across different sound jobs", async () => {
    const startsAt = new Date(Date.now() + 70 * 86_400_000);
    const first = await seedOpenTechJob(startsAt, techId2);
    const second = await seedOpenTechJob(
      new Date(startsAt.getTime() + 30 * 60_000),
      techId2,
    );

    const results = await Promise.allSettled(
      [first, second].map((job) =>
        bookTechApplicant({
          subslotId: job.subslotId,
          techId: techId2,
          actor: userV,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TechUnavailableError);

    const jobRows = await db()
      .select({ state: techSubslots.state })
      .from(techSubslots)
      .where(inArray(techSubslots.id, [first.subslotId, second.subslotId]));
    expect(jobRows.filter((row) => row.state === "booked")).toHaveLength(1);
    expect(jobRows.filter((row) => row.state === "open")).toHaveLength(1);
    const applicationRows = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(
        inArray(techSubslotApplications.subslotId, [
          first.subslotId,
          second.subslotId,
        ]),
      );
    expect(applicationRows.filter((row) => row.status === "booked")).toHaveLength(1);
    expect(applicationRows.filter((row) => row.status === "submitted")).toHaveLength(1);
  });

  it("booking a tech writes exactly one charge ledger row for the payer", async () => {
    const r = await runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV);
    expect(r.to).toBe("booked");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const subCharges = rows.filter(
      (l) => l.entryType === "charge" && l.amountCents === 25_000,
    );
    expect(subCharges).toHaveLength(1);
    expect(subCharges[0]!.debitParty).toBe(`venue:${venueId}`);
  });

  it("re-running the same transition is rejected (no double charge)", async () => {
    await expect(
      runSubslotTransition(subslotId, { kind: "TECH_BOOKED", techId }, userV),
    ).rejects.toThrow();
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    expect(rows.filter((l) => l.entryType === "charge" && l.amountCents === 25_000)).toHaveLength(1);
  });

  it("tech cancellation refunds in full and reopens the sub-slot", async () => {
    const r = await runSubslotTransition(subslotId, { kind: "TECH_CANCELLED" }, userT);
    expect(r.to).toBe("open");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const refund = rows.find((l) => l.entryType === "refund" && l.amountCents === 25_000);
    expect(refund?.creditParty).toBe(`venue:${venueId}`);
    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.techId).toBeNull();
    const [cancelledTech] = await db()
      .select({ strikes: techs.reliabilityStrikes })
      .from(techs)
      .where(eq(techs.id, techId));
    expect(cancelledTech!.strikes).toBe(1);
  });

  it("applies, withdraws, and books a submitted tech as one atomic lifecycle", async () => {
    await applyToOpenTechSubslot({
      subslotId,
      techId,
      actor: userT,
      note: "First round",
    });
    await applyToOpenTechSubslot({
      subslotId,
      techId: techId2,
      actor: userT2,
    });
    await withdrawTechSubslotApplication({
      subslotId,
      techId,
      actor: userT,
    });

    await expect(
      bookTechApplicant({ subslotId, techId, actor: userV }),
    ).rejects.toMatchObject<TechSubslotApplicationError>({
      reason: "not_found",
    });
    const [stillOpen] = await db()
      .select({ state: techSubslots.state })
      .from(techSubslots)
      .where(eq(techSubslots.id, subslotId));
    expect(stillOpen?.state).toBe("open");

    // Re-applying is allowed after a withdrawal. Selecting tech 2 must mark
    // this new pending row declined in the same commit as the booking.
    await applyToOpenTechSubslot({
      subslotId,
      techId,
      actor: userT,
      note: "Available again",
    });
    const booked = await bookTechApplicant({
      subslotId,
      techId: techId2,
      actor: userV,
    });
    expect(booked.to).toBe("booked");
    const applicationRows = await db()
      .select({ techId: techSubslotApplications.techId, status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.subslotId, subslotId));
    expect(applicationRows).toEqual(
      expect.arrayContaining([
        { techId, status: "declined" },
        { techId: techId2, status: "booked" },
      ]),
    );

    await expect(
      withdrawTechSubslotApplication({
        subslotId,
        techId: techId2,
        actor: userT2,
      }),
    ).rejects.toMatchObject<TechSubslotApplicationError>({
      reason: "not_submitted",
    });
    const [winner] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(
        and(
          eq(techSubslotApplications.subslotId, subslotId),
          eq(techSubslotApplications.techId, techId2),
        ),
      );
    expect(winner?.status).toBe("booked");
  });

  it("does not apply when the request waits across downbeat", async () => {
    const startsAt = new Date(Date.now() + 15 * 86_400_000);
    const downbeatBookingId = await seedConfirmedBooking(startsAt);
    const downbeatSubslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: downbeatSubslotId,
      bookingId: downbeatBookingId,
      payer: "venue",
      budgetCents: 6_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 3 },
      state: "open",
    });

    let clockReads = 0;
    await expect(
      applyToOpenTechSubslot(
        {
          subslotId: downbeatSubslotId,
          techId,
          actor: userT,
          note: "too late",
        },
        {
          clock: () => {
            clockReads += 1;
            return clockReads === 1
              ? new Date(startsAt.getTime() - 1)
              : startsAt;
          },
        },
      ),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);
    expect(clockReads).toBeGreaterThanOrEqual(2);

    const applicationsAfter = await db()
      .select({ id: techSubslotApplications.id })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.subslotId, downbeatSubslotId));
    expect(applicationsAfter).toHaveLength(0);
    const [subslotAfter] = await db()
      .select({ state: techSubslots.state, version: techSubslots.version })
      .from(techSubslots)
      .where(eq(techSubslots.id, downbeatSubslotId));
    expect(subslotAfter).toEqual({ state: "open", version: 1 });
    const applicationEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectId, downbeatSubslotId),
          eq(events.kind, "subslot.application"),
        ),
      );
    expect(applicationEvents).toHaveLength(0);
  });

  it("does not book an applicant when the request waits across downbeat", async () => {
    const startsAt = new Date(Date.now() + 15 * 86_400_000);
    const downbeatBookingId = await seedConfirmedBooking(startsAt);
    const downbeatSubslotId = newId("slot");
    const pendingApplicationId = newId("application");
    await db().insert(techSubslots).values({
      id: downbeatSubslotId,
      bookingId: downbeatBookingId,
      payer: "venue",
      budgetCents: 7_500,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state: "open",
    });
    await db().insert(techSubslotApplications).values({
      id: pendingApplicationId,
      subslotId: downbeatSubslotId,
      techId,
      status: "submitted",
    });

    let clockReads = 0;
    await expect(
      bookTechApplicant(
        {
          subslotId: downbeatSubslotId,
          techId,
          actor: userV,
        },
        {
          clock: () => {
            clockReads += 1;
            return clockReads === 1
              ? new Date(startsAt.getTime() - 1)
              : startsAt;
          },
        },
      ),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);
    expect(clockReads).toBeGreaterThanOrEqual(2);

    const [subslotAfter] = await db()
      .select({
        state: techSubslots.state,
        techId: techSubslots.techId,
        version: techSubslots.version,
      })
      .from(techSubslots)
      .where(eq(techSubslots.id, downbeatSubslotId));
    expect(subslotAfter).toEqual({ state: "open", techId: null, version: 1 });
    const [applicationAfter] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.id, pendingApplicationId));
    expect(applicationAfter?.status).toBe("submitted");
    const charges = await db()
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, downbeatBookingId));
    expect(charges).toHaveLength(0);
    const transitionEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectId, downbeatSubslotId),
          eq(events.kind, "subslot.transition"),
        ),
      );
    expect(transitionEvents).toHaveLength(0);
  });

  it("parent cancellation <48h out cascades: 100% of the sub-slot budget to the tech", async () => {
    // Keep open and booked cascade coverage on separate parent bookings: the
    // database now correctly forbids two active sound jobs on one booking.
    const openBookingId = await seedConfirmedBooking();
    const openSubslotId = await createTechSubslot({
      bookingId: openBookingId,
      payer: "venue",
      budgetCents: 9_000,
      actor: userV,
    });
    const pendingApplicationId = await applyToOpenTechSubslot({
      subslotId: openSubslotId,
      techId: techId3,
      actor: userT3,
    });
    await db()
      .update(bookings)
      .set({ state: "cancelled_by_venue" })
      .where(eq(bookings.id, openBookingId));
    await cascadeParentToSubslots(openBookingId, "cancelled", "worker");

    // Also leave a legacy/race-era submitted row beside the booked winner.
    // Both pending applications must close truthfully with their own parent.
    await db()
      .update(techSubslotApplications)
      .set({ status: "submitted" })
      .where(
        and(
          eq(techSubslotApplications.subslotId, subslotId),
          eq(techSubslotApplications.techId, techId),
        ),
      );

    await runBookingTransition(bookingId, { kind: "VENUE_CANCELLED" }, userV);

    // The booking event has committed but the asynchronous cascade has not.
    // A stale detail page still cannot add another application in this gap.
    await expect(
      applyToOpenTechSubslot({
        subslotId,
        techId: techId3,
        actor: userT3,
      }),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);
    await cascadeParentToSubslots(bookingId, "cancelled", "worker");

    const [s] = await db().select().from(techSubslots).where(eq(techSubslots.id, subslotId));
    expect(s.state).toBe("cancelled_with_parent");
    const rows = await db()
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.bookingId, bookingId));
    const techFee = rows.find(
      (l) => l.entryType === "fee" && l.creditParty === `tech:${techId2}`,
    );
    expect(techFee?.amountCents).toBe(25_000); // <48h ⇒ 100%

    const [pending] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.id, pendingApplicationId));
    expect(pending?.status).toBe("declined");
    const [legacy] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(
        and(
          eq(techSubslotApplications.subslotId, subslotId),
          eq(techSubslotApplications.techId, techId),
        ),
      );
    expect(legacy?.status).toBe("declined");
    for (const closedSubslotId of [openSubslotId, subslotId]) {
      const outcomes = await db()
        .select({ kind: events.kind, payload: events.payload })
        .from(events)
        .where(eq(events.subjectId, closedSubslotId));
      expect(outcomes).toEqual(
        expect.arrayContaining([
          {
            kind: "subslot.application_declined",
            payload: expect.objectContaining({
              reason: "sound_job_closed",
              effects: [
                expect.objectContaining({
                  template: "subslot_application_cancelled",
                  to: "applicant",
                }),
              ],
            }),
          },
        ]),
      );
    }

    // money conserves across BOTH the booking and its sub-slot
    const totals = await bookingLedger(db(), bookingId);
    expect(totals.chargedCents).toBe(
      totals.releasedCents + totals.refundedCents,
    );
  });

  it("rejects an application after parent close without inserting a row or event", async () => {
    const beforeEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.subjectId, subslotId));
    await expect(
      applyToOpenTechSubslot({
        subslotId,
        techId: techId3,
        actor: userT3,
      }),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);
    const application = await db()
      .select({ id: techSubslotApplications.id })
      .from(techSubslotApplications)
      .where(
        and(
          eq(techSubslotApplications.subslotId, subslotId),
          eq(techSubslotApplications.techId, techId3),
        ),
      );
    expect(application).toHaveLength(0);
    const afterEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.subjectId, subslotId));
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it("does not reopen a booked sound job after its parent closes", async () => {
    const closedBookingId = await seedConfirmedBooking();
    const closedSubslotId = newId("slot");
    const bookedApplicationId = newId("application");
    await db().insert(techSubslots).values({
      id: closedSubslotId,
      bookingId: closedBookingId,
      payer: "venue",
      budgetCents: 8_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state: "booked",
      techId: techId2,
    });
    await db().insert(techSubslotApplications).values({
      id: bookedApplicationId,
      subslotId: closedSubslotId,
      techId: techId2,
      status: "booked",
    });
    await db()
      .update(bookings)
      .set({ state: "cancelled_by_venue" })
      .where(eq(bookings.id, closedBookingId));
    const [beforeTech] = await db()
      .select({ strikes: techs.reliabilityStrikes })
      .from(techs)
      .where(eq(techs.id, techId2));

    await expect(
      runSubslotTransition(
        closedSubslotId,
        { kind: "TECH_CANCELLED" },
        userT2,
      ),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);

    const [subslot] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, closedSubslotId));
    expect(subslot).toEqual({ state: "booked", techId: techId2 });
    const [application] = await db()
      .select({ status: techSubslotApplications.status })
      .from(techSubslotApplications)
      .where(eq(techSubslotApplications.id, bookedApplicationId));
    expect(application?.status).toBe("booked");
    const [afterTech] = await db()
      .select({ strikes: techs.reliabilityStrikes })
      .from(techs)
      .where(eq(techs.id, techId2));
    expect(afterTech?.strikes).toBe(beforeTech?.strikes);
    const transitionEvents = await db()
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectId, closedSubslotId),
          eq(events.kind, "subslot.transition"),
        ),
      );
    expect(transitionEvents).toHaveLength(0);
  });

  it("does not reopen when a cancellation request waits across downbeat", async () => {
    const startsAt = new Date(Date.now() + 15 * 86_400_000);
    const downbeatBookingId = await seedConfirmedBooking(startsAt);
    const downbeatSubslotId = newId("slot");
    await db().insert(techSubslots).values({
      id: downbeatSubslotId,
      bookingId: downbeatBookingId,
      payer: "performer",
      budgetCents: 7_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 3 },
      state: "booked",
      techId,
    });

    let clockReads = 0;
    await expect(
      runSubslotTransition(
        downbeatSubslotId,
        { kind: "TECH_CANCELLED" },
        userT,
        {
          clock: () => {
            clockReads += 1;
            return clockReads === 1
              ? new Date(startsAt.getTime() - 1)
              : startsAt;
          },
        },
      ),
    ).rejects.toBeInstanceOf(TechSubslotParentUnavailableError);
    expect(clockReads).toBeGreaterThanOrEqual(2);
    const [subslot] = await db()
      .select({ state: techSubslots.state, techId: techSubslots.techId })
      .from(techSubslots)
      .where(eq(techSubslots.id, downbeatSubslotId));
    expect(subslot).toEqual({ state: "booked", techId });
  });
});
