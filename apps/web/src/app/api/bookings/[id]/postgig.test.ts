import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

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
    const { bookingId } = await makeConfirmed();
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    as(uVenue);
    expect((await dispute(bookingId)).status).toBe(200);
    expect(await stateOf(bookingId)).toBe("disputed");
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

  it("rebook on a non-series booking is a clean 409", async () => {
    const { bookingId } = await makeConfirmed();
    as(uVenue);
    const res = await rebookNext(bookingId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_rebook_target");
  });
});
