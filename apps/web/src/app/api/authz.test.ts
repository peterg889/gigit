import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as acceptPost } from "./bookings/[id]/accept/route";
import { POST as cancelPost } from "./bookings/[id]/cancel/route";
import { POST as offerPost } from "./applications/[id]/offer/route";
import { POST as adminStatusPost } from "./admin/users/[id]/status/route";

type Handler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const post = (handler: Handler, id: string, body?: unknown) =>
  handler(
    new Request(`http://test/x/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/**
 * The mutation/authz layer is enforced with hand-rolled inline checks and was
 * entirely untested (audit #5). This locks the matrix: unauth → 401, wrong
 * party → 403, admin gate, and the shared suspended-user lock in requireUser.
 */
describe("web API authz matrix (audit #5)", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uRival = newId("user");
  const uAdmin = newId("user");
  const uStranger = newId("user");
  const venueId = newId("venue");
  const pBand = newId("performer");
  const pRival = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uVenue, uBand, uRival, uAdmin, uStranger].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d.insert(schema.actorRoles).values({ id: newId("role"), userId: uAdmin, kind: "admin" });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Authz Bar",
      metro: "authz-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values([
      { id: pBand, ownerUserId: uBand, kind: "band", name: "Authz Band", homeMetro: "authz-tv" },
      { id: pRival, ownerUserId: uRival, kind: "solo", name: "Authz Rival", homeMetro: "authz-tv" },
    ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  async function offeredBooking() {
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 14 * 86_400_000);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "authz-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
    });
    await db().insert(schema.applications).values({ id: appId, slotId, performerId: pBand });
    const bookingId = await createOffer({
      applicationId: appId,
      slotId,
      performerId: pBand,
      venueId,
      actor: uVenue,
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    return { slotId, appId, bookingId };
  }

  it("accept: 401 unauthenticated, 403 a different performer, 200 the booking's performer", async () => {
    const { bookingId } = await offeredBooking();
    as(null);
    expect((await post(acceptPost, bookingId)).status).toBe(401);
    as(uRival);
    expect((await post(acceptPost, bookingId)).status).toBe(403);
    as(uBand);
    expect((await post(acceptPost, bookingId)).status).toBe(200);
  });

  it("accept: 403 when the account is suspended (the shared requireUser lock)", async () => {
    const { bookingId } = await offeredBooking();
    as(uAdmin);
    expect((await post(adminStatusPost, uBand, { status: "suspended" })).status).toBe(200);
    as(uBand);
    expect((await post(acceptPost, bookingId)).status).toBe(403);
    as(uAdmin); // reinstate for the next test
    await post(adminStatusPost, uBand, { status: "active" });
  });

  it("cancel: 403 a non-party, 200 a party (the venue)", async () => {
    const { bookingId } = await offeredBooking();
    as(uBand);
    await post(acceptPost, bookingId);
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    as(uStranger);
    expect((await post(cancelPost, bookingId)).status).toBe(403);
    as(uVenue);
    expect((await post(cancelPost, bookingId)).status).toBe(200);
  });

  it("offer: 403 when the caller doesn't own the slot's venue", async () => {
    const slotId = newId("slot");
    const appId = newId("application");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "authz-tv",
      startsAt: new Date(Date.now() + 14 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(schema.applications).values({ id: appId, slotId, performerId: pRival });
    as(uStranger);
    expect((await post(offerPost, appId, { amountCents: 30_000 })).status).toBe(403);
  });

  it("admin status: 403 for a non-admin, 200 for an admin", async () => {
    as(uStranger);
    expect((await post(adminStatusPost, uRival, { status: "suspended" })).status).toBe(403);
    as(uAdmin);
    expect((await post(adminStatusPost, uRival, { status: "suspended" })).status).toBe(200);
    as(uAdmin);
    await post(adminStatusPost, uRival, { status: "active" });
  });
});
