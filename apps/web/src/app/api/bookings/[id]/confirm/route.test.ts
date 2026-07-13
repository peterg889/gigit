import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const confirm = (id: string) =>
  POST(new Request(`http://test/x/${id}`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

/**
 * Venue confirm-and-release (audit edgecases #5): VENUE_CONFIRMED had no entry
 * point, so a venue could only wait out the 24h auto-confirm. This route lets
 * the venue release now; only the booking's venue may, and only post-gig.
 */
describe("venue confirm route", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let bookingSequence = 0;

  async function makeBooking(): Promise<string> {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + (3 + bookingSequence++) * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "cf-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await d.insert(schema.applications).values({ id: appId, slotId, performerId });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId,
      venueId,
      actor: uVenue,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    return bookingId;
  }

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Confirm Bar",
      metro: "cf-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Confirm Band",
      homeMetro: "cf-tv",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("409 before the gig ends (still confirmed, not awaiting_confirmation)", async () => {
    const bookingId = await makeBooking();
    as(uVenue);
    expect((await confirm(bookingId)).status).toBe(409);
  });

  it("403 for the performer, 200 + released for the venue post-gig", async () => {
    const bookingId = await makeBooking();
    await runBookingTransition(bookingId, { kind: "GIG_ENDED" }, "worker");
    as(uBand);
    expect((await confirm(bookingId)).status).toBe(403);
    as(uVenue);
    const res = await confirm(bookingId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "released" });
  });

  it("404 for a missing booking, 401 unauthenticated", async () => {
    as(uVenue);
    expect((await confirm(newId("booking"))).status).toBe(404);
    as(null);
    expect((await confirm(newId("booking"))).status).toBe(401);
  });
});
