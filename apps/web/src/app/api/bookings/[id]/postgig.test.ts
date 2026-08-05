import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { VenuePaymentMethodRequiredError, closeDb, createOffer, db, getPool, makeUser, makeVenue, runBookingTransition, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";

const offerPaymentGate = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@gigit/db", async (original) => ({
  ...(await original<typeof import("@gigit/db")>()),
  assertVenueOfferPaymentReady: async () => {
    if (offerPaymentGate.error) throw offerPaymentGate.error;
  },
}));

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as markPlayed } from "./mark-played/route";
import { POST as openDispute } from "./dispute/route";
import { POST as rebook } from "./rebook/route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const played = (id: string) =>
  markPlayed(new Request(`http://test/x/${id}`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
const dispute = (id: string, reason = "band never showed up") =>
  openDispute(
    new Request(`http://test/x/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "no_show", reason }),
    }),
    { params: Promise.resolve({ id }) },
  );
const rebookNext = (id: string) =>
  rebook(new Request(`http://test/x/${id}`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

/**
 * Post-gig window (F4.2/F7.4) and the residency re-book loop (F2.2): the
 * routes that decide money release and repeat business had no direct tests.
 */
describe("post-gig routes", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const seriesId = newId("series");
  let seq = 0;

  async function makeConfirmed(opts: { inSeries?: boolean } = {}) {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + (20 + seq++) * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "postgig-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
      ...(opts.inSeries ? { seriesId, source: "series" } : {}),
    });
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: uVenue,
      terms: {
        amountCents: 20_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    return { bookingId, slotId };
  }

  const stateOf = async (id: string) =>
    (
      await db()
        .select({ s: schema.bookings.state })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, id))
    )[0]?.s;

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Postgig Bar",
      metro: "postgig-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Postgig Band",
      homeMetro: "postgig-tv",
    });
    await d.insert(schema.slotSeries).values({
      id: seriesId,
      venueId,
      metro: "postgig-tv",
      pattern: {
        freq: "weekly",
        dayOfWeek: 5,
        startTimeLocal: "20:00",
        timeZone: "America/Chicago",
        durationMinutes: 120,
      },
      defaults: { format: "music", genrePrefs: [], budgetCents: 20_000, provides: {} },
    });
  });
  afterEach(() => {
    offerPaymentGate.error = null;
  });
  afterAll(async () => {
    await closeDb();
  });

  it("mark-played only after the gig ends, and only by the performer", async () => {
    const { bookingId } = await makeConfirmed();
    as(uBand);
    expect((await played(bookingId)).status).toBe(409); // still confirmed
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    as(uVenue);
    expect((await played(bookingId)).status).toBe(403);
    as(uBand);
    expect((await played(bookingId)).status).toBe(200);
    expect(await stateOf(bookingId)).toBe("awaiting_confirmation");
  });

  it("either party can open a dispute in the post-gig window; strangers cannot", async () => {
    // The title promised three things and the body tested one — only the venue.
    // The guard is a single `else return fail(...)`, so simplifying it (dropping
    // the id comparison, say) would let anyone holding ANY venue profile freeze
    // any booking's payout, with this test green.
    const first = await makeConfirmed();
    await runBookingTransition(first.bookingId, { kind: "GIG_ENDED" }, "worker");
    as(uVenue);
    expect((await dispute(first.bookingId)).status).toBe(200);
    expect(await stateOf(first.bookingId)).toBe("disputed");

    // the act's side of "either party"
    const second = await makeConfirmed();
    await runBookingTransition(second.bookingId, { kind: "GIG_ENDED" }, "worker");
    as(uBand);
    expect((await dispute(second.bookingId)).status).toBe(200);
    expect(await stateOf(second.bookingId)).toBe("disputed");

    // ...and "strangers cannot", including a stranger who owns an unrelated
    // venue — that's the case a weakened comparison would let through.
    const third = await makeConfirmed();
    await runBookingTransition(third.bookingId, { kind: "GIG_ENDED" }, "worker");
    const other = await makeVenue({ name: "Unrelated Room" });
    as(other.ownerUserId);
    expect((await dispute(third.bookingId)).status).toBe(403);
    expect(await stateOf(third.bookingId)).toBe("awaiting_confirmation"); // untouched

    const nobody = await makeUser();
    as(nobody);
    expect((await dispute(third.bookingId)).status).toBe(403);
    expect(await stateOf(third.bookingId)).toBe("awaiting_confirmation");
  });

  it("dispute outside the window is a 409, and reasons are validated", async () => {
    const { bookingId } = await makeConfirmed();
    as(uBand);
    expect((await dispute(bookingId)).status).toBe(409); // confirmed, gig not ended
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    expect((await dispute(bookingId, "bad")).status).toBe(422); // reason too short
  });

  it("venue re-books the same act into the next open series night", async () => {
    const { bookingId } = await makeConfirmed({ inSeries: true });
    // A later open night in the same series to re-book into.
    const nextSlotId = newId("slot");
    await db().insert(schema.slots).values({
      id: nextSlotId,
      venueId,
      seriesId,
      source: "series",
      metro: "postgig-tv",
      startsAt: new Date(Date.now() + 90 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
    });

    as(uBand);
    expect((await rebookNext(bookingId)).status).toBe(403); // venue-only
    as(uVenue);
    const res = await rebookNext(bookingId);
    expect(res.status).toBe(201);
    const { bookingId: newBooking } = await res.json();
    expect(await stateOf(newBooking)).toBe("offered");
    // and it targeted the open series night
    const [nb] = await db()
      .select({ slotId: schema.bookings.slotId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, newBooking));
    expect(nb?.slotId).toBe(nextSlotId);

    // a second rebook has no remaining open night → clean 409
    expect((await rebookNext(bookingId)).status).toBe(409);
  });

  it("rebook will not offer a hidden act or an act whose account is suspended", async () => {
    const { bookingId } = await makeConfirmed();
    const targetSlotId = newId("slot");
    await db().insert(schema.slots).values({
      id: targetSlotId,
      venueId,
      metro: "postgig-tv",
      startsAt: new Date(Date.now() + 150 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 22_000,
    });

    as(uVenue);
    try {
      await db()
        .update(schema.performers)
        .set({ status: "hidden" })
        .where(eq(schema.performers.id, performerId));
      let response = await rebookNext(bookingId);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("no_rebook_target");

      await db()
        .update(schema.performers)
        .set({ status: "live" })
        .where(eq(schema.performers.id, performerId));
      await db()
        .update(schema.users)
        .set({ status: "suspended" })
        .where(eq(schema.users.id, uBand));
      response = await rebookNext(bookingId);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("no_rebook_target");

      const applications = await db()
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(
          and(
            eq(schema.applications.slotId, targetSlotId),
            eq(schema.applications.performerId, performerId),
          ),
        );
      expect(applications).toHaveLength(0);
    } finally {
      await db()
        .update(schema.users)
        .set({ status: "active" })
        .where(eq(schema.users.id, uBand));
      await db()
        .update(schema.performers)
        .set({ status: "live" })
        .where(eq(schema.performers.id, performerId));
      await db()
        .update(schema.slots)
        .set({ status: "cancelled" })
        .where(eq(schema.slots.id, targetSlotId));
    }
  });

  it("rebook on a non-series booking is a clean 409", async () => {
    const { bookingId } = await makeConfirmed();
    as(uVenue);
    const res = await rebookNext(bookingId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("no_rebook_target");
    expect(body.error.message).toMatch(/at this venue/i);
    expect(body.error.message).not.toMatch(/this series/i);
  });

  it("does not rebook when the venue cannot be charged", async () => {
    const { bookingId } = await makeConfirmed();
    const targetSlotId = newId("slot");
    await db().insert(schema.slots).values({
      id: targetSlotId,
      venueId,
      metro: "postgig-tv",
      startsAt: new Date(Date.now() + 170 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 23_000,
    });

    try {
      offerPaymentGate.error = new VenuePaymentMethodRequiredError(venueId);
      as(uVenue);
      const response = await rebookNext(bookingId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "payment_method_required",
          message: expect.stringMatching(/payment method/i),
        },
      });
      const applications = await db()
        .select({ id: schema.applications.id })
        .from(schema.applications)
        .where(eq(schema.applications.slotId, targetSlotId));
      expect(applications).toHaveLength(0);
      const bookings = await db()
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(eq(schema.bookings.slotId, targetSlotId));
      expect(bookings).toHaveLength(0);
    } finally {
      await db()
        .update(schema.slots)
        .set({ status: "cancelled" })
        .where(eq(schema.slots.id, targetSlotId));
    }
  });

  it("rebook returns a clean conflict and rolls back its synthetic application", async () => {
    const { bookingId } = await makeConfirmed();
    const targetSlotId = newId("slot");
    await db().insert(schema.slots).values({
      id: targetSlotId,
      venueId,
      metro: "postgig-tv",
      startsAt: new Date(Date.now() + 180 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 24_000,
    });

    // Simulate the target losing a uniqueness race after findRebookTarget but
    // while the atomic helper is inserting the offer. Raising SQLSTATE 23505
    // through a trigger also pins the wrapped-error mapping used in production.
    const suffix = targetSlotId.slice(-16).toLowerCase();
    const functionName = `fail_rebook_offer_${suffix}`;
    const triggerName = `fail_rebook_offer_trigger_${suffix}`;
    const pool = getPool();
    await pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.slot_id = '${targetSlotId}' then
          raise exception 'forced competing offer' using errcode = '23505';
        end if;
        return new;
      end
      $$
    `);
    await pool.query(`
      create trigger ${triggerName}
      before insert on bookings
      for each row execute function ${functionName}()
    `);

    let response: Response;
    try {
      as(uVenue);
      response = await rebookNext(bookingId);
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on bookings`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    expect(response!.status).toBe(409);
    expect((await response!.json()).error.code).toBe("slot_unavailable");
    const applications = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.slotId, targetSlotId),
          eq(schema.applications.performerId, performerId),
        ),
      );
    expect(applications).toHaveLength(0);
  });
});
