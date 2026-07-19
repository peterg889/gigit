import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const accept = (id: string, body: unknown = { acceptedTerms: true }) =>
  POST(
    new Request(`http://test/api/bookings/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/**
 * The accept route is the single moment a performer commits to a gig — it had
 * no direct test. Covers: party check, explicit terms consent, offer expiry,
 * the happy path into `confirming`, and the calendar-overlap guard.
 */
describe("performer accept route", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uOther = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const otherPerformerId = newId("performer");
  let seq = 0;

  async function makeOffer(opts: { startsAt?: Date; ttlHours?: number } = {}) {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt =
      opts.startsAt ?? new Date(Date.now() + (5 + seq++) * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "accept-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 25_000,
    });
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    return createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: uVenue,
      ...(opts.ttlHours ? { offerTtlHours: opts.ttlHours } : {}),
      terms: {
        amountCents: 25_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
  }

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand, uOther].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Accept Bar",
      metro: "accept-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values([
      {
        id: performerId,
        ownerUserId: uBand,
        kind: "band",
        name: "Accept Band",
        homeMetro: "accept-tv",
      },
      {
        id: otherPerformerId,
        ownerUserId: uOther,
        kind: "solo",
        name: "Bystander",
        homeMetro: "accept-tv",
      },
    ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("moves the booking to confirming for the offer's performer", async () => {
    const bookingId = await makeOffer();
    as(uBand);
    const res = await accept(bookingId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "confirming" });
  });

  it("rejects a different performer with 403", async () => {
    const bookingId = await makeOffer();
    as(uOther);
    const res = await accept(bookingId);
    expect(res.status).toBe(403);
  });

  it("requires the explicit acceptedTerms consent", async () => {
    const bookingId = await makeOffer();
    as(uBand);
    const res = await accept(bookingId, {});
    expect(res.status).toBe(422);
    // and nothing moved
    const [b] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    expect(b?.state).toBe("offered");
  });

  it("returns offer_expired after the TTL passes", async () => {
    const bookingId = await makeOffer();
    // Age the offer out under the route (no fake timers: shift expiry into the past).
    await db()
      .update(schema.bookings)
      .set({ offerExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.bookings.id, bookingId));
    as(uBand);
    const res = await accept(bookingId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "offer_expired" } });
  });

  it("blocks accepting an overlapping second booking (double-book guard)", async () => {
    const startsAt = new Date(Date.now() + 200 * 86_400_000);
    const first = await makeOffer({ startsAt });
    as(uBand);
    expect((await accept(first)).status).toBe(200);
    // NullPaymentGateway confirms asynchronously via the worker in prod; drive
    // the payment success directly so the first booking occupies the calendar.
    const { runBookingTransition } = await import("@gigit/db");
    await runBookingTransition(first, { kind: "PAYMENT_SUCCEEDED" }, "test");

    const second = await makeOffer({ startsAt });
    const res = await accept(second);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "performer_unavailable" },
    });
  });

  it("404s for a missing booking", async () => {
    as(uBand);
    const res = await accept(newId("booking"));
    expect(res.status).toBe(404);
  });
});
