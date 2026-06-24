import { newId } from "@gigit/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import {
  ConcurrentUpdateError,
  IllegalTransitionError,
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

  async function makeSlotWithApplications() {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const rivalAppId = newId("application");
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
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

  it("prevents double-booking: two offers on one slot, only one can advance past 'offered'", async () => {
    const d = db();
    const { slotId, appId, rivalAppId, startsAt } = await makeSlotWithApplications();
    const terms = {
      amountCents: 50_000,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    };
    // a venue may offer BOTH applicants — both bookings sit in 'offered'
    const b1 = await createOffer({ applicationId: appId, slotId, performerId, venueId, actor: userVenue, terms });
    const b2 = await createOffer({
      applicationId: rivalAppId,
      slotId,
      performerId: rivalPerformerId,
      venueId,
      actor: userVenue,
      terms,
    });

    // first acceptance takes the slot
    const a1 = await runBookingTransition(b1, { kind: "PERFORMER_ACCEPTED" }, userBand);
    expect(a1.to).toBe("confirming");

    // the second is rejected — the slot is no longer available
    await expect(
      runBookingTransition(b2, { kind: "PERFORMER_ACCEPTED" }, userBand),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    // and b2 is unchanged (its transaction rolled back)
    const [r2] = await d.select().from(bookings).where(eq(bookings.id, b2));
    expect(r2!.state).toBe("offered");
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
});
