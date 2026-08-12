import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import {
  VenuePaymentMethodRequiredError,
  closeDb,
  createOffer,
  db,
  runBookingTransition,
  schema,
} from "@gigit/db";

const offerPaymentGate = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@gigit/db", async (original) => ({
  ...(await original<typeof import("@gigit/db")>()),
  assertVenueOfferPaymentReady: async () => {
    if (offerPaymentGate.error) throw offerPaymentGate.error;
  },
}));

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as acceptPost } from "./bookings/[id]/accept/route";
import { POST as cancelPost } from "./bookings/[id]/cancel/route";
import { POST as offerPost } from "./applications/[id]/offer/route";
import { POST as adminStatusPost } from "./admin/users/[id]/status/route";
import { GET as slotApplicantsGet } from "./slots/[id]/applications/route";
import { PATCH as venuePatch } from "./venues/[id]/route";
import { POST as mediaEmbedPost } from "./media/embed/route";

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
  const rivalVenueId = newId("venue");
  const pBand = newId("performer");
  const pRival = newId("performer");
  let bookingSequence = 0;

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uVenue, uBand, uRival, uAdmin, uStranger].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d.insert(schema.actorRoles).values({ id: newId("role"), userId: uAdmin, kind: "admin" });
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Authz Bar",
      metro: "authz-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: rivalVenueId,
      ownerUserId: uRival,
      kind: "bar",
      name: "Authz Rival Bar",
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
  afterEach(() => {
    offerPaymentGate.error = null;
  });

  async function offeredBooking() {
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + (14 + bookingSequence++) * 86_400_000);
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
    expect((await post(acceptPost, bookingId, { acceptedTerms: true })).status).toBe(401);
    as(uRival);
    expect((await post(acceptPost, bookingId, { acceptedTerms: true })).status).toBe(403);
    as(uBand);
    expect((await post(acceptPost, bookingId, { acceptedTerms: true })).status).toBe(200);
  });

  it("accept: requires explicit confirmation of the displayed deal", async () => {
    const { bookingId } = await offeredBooking();
    as(uBand);
    expect((await post(acceptPost, bookingId, {})).status).toBe(422);
  });

  it("accept: 403 when the account is suspended (the shared requireUser lock)", async () => {
    const { bookingId } = await offeredBooking();
    as(uAdmin);
    expect((await post(adminStatusPost, uBand, { status: "suspended" })).status).toBe(200);
    try {
      as(uBand);
      expect((await post(acceptPost, bookingId, { acceptedTerms: true })).status).toBe(403);
    } finally {
      as(uAdmin); // always reinstate so a failed assert can't poison later tests
      await post(adminStatusPost, uBand, { status: "active" });
    }
  });

  it("cancel: performer can decline an unaccepted firm offer", async () => {
    const { appId, bookingId } = await offeredBooking();
    as(uBand);
    const response = await post(cancelPost, bookingId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "collapsed" });
    const [application] = await db()
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, appId));
    expect(application!.status).toBe("withdrawn");
  });

  it("cancel: 403 a non-party, 200 a party (the venue)", async () => {
    const { bookingId } = await offeredBooking();
    as(uBand);
    await post(acceptPost, bookingId, { acceptedTerms: true });
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

  it("offer: requires venue payment readiness before creating a booking", async () => {
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "authz-tv",
      startsAt: new Date(Date.now() + 21 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(schema.applications).values({
      id: applicationId,
      slotId,
      performerId: pBand,
    });

    offerPaymentGate.error = new VenuePaymentMethodRequiredError(venueId);
    as(uVenue);
    const response = await post(offerPost, applicationId, {
      amountCents: 30_000,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "payment_method_required",
        message: expect.stringMatching(/payment method/i),
      },
    });
    const bookingRows = await db()
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.slotId, slotId));
    expect(bookingRows).toHaveLength(0);
    const [application] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId));
    expect(application?.status).toBe("submitted");
  });

  it("offer: enforces advertised pay and one firm offer per slot", async () => {
    const slotId = newId("slot");
    const firstApplicationId = newId("application");
    const rivalApplicationId = newId("application");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "authz-tv",
      startsAt: new Date(Date.now() + 14 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(schema.applications).values([
      {
        id: firstApplicationId,
        slotId,
        performerId: pBand,
      },
      {
        id: rivalApplicationId,
        slotId,
        performerId: pRival,
      },
    ]);
    as(uVenue);
    expect(
      (await post(offerPost, firstApplicationId, {
        amountCents: 25_000,
      })).status,
    ).toBe(400);
    expect(
      (await post(offerPost, firstApplicationId, {
        amountCents: 30_000,
      })).status,
    ).toBe(201);
    expect(
      (await post(offerPost, rivalApplicationId, {
        amountCents: 30_000,
      })).status,
    ).toBe(409);
  });

  it("offer: rejects a stale open date after its start time with accurate copy", async () => {
    const slotId = newId("slot");
    const applicationId = newId("application");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "authz-tv",
      startsAt: new Date(Date.now() - 60_000),
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db()
      .insert(schema.applications)
      .values({ id: applicationId, slotId, performerId: pBand });

    as(uVenue);
    const response = await post(offerPost, applicationId, { amountCents: 30_000 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "conflict", message: expect.stringMatching(/already passed/i) },
    });

    const [application] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId));
    expect(application?.status).toBe("submitted");
    const bookings = await db()
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.slotId, slotId));
    expect(bookings).toHaveLength(0);
  });

  it("admin status: 403 for a non-admin, 200 for an admin", async () => {
    as(uStranger);
    expect((await post(adminStatusPost, uRival, { status: "suspended" })).status).toBe(403);
    as(uAdmin);
    expect((await post(adminStatusPost, uRival, { status: "suspended" })).status).toBe(200);
    as(uAdmin);
    await post(adminStatusPost, uRival, { status: "active" });
  });

  describe("boundaries that had no test", () => {
    it("a rival venue cannot read who applied to someone else's date", async () => {
      // The guard is correct; it just had nothing pinning it. A competitor's full
      // applicant list is exactly the read you don't want unguarded.
      const { slotId } = await offeredBooking();
      as(uRival);
      const res = await slotApplicantsGet(new Request("http://test"), {
        params: Promise.resolve({ id: slotId }),
      });
      expect(res.status).toBe(403);

      as(uVenue);
      const mine = await slotApplicantsGet(new Request("http://test"), {
        params: Promise.resolve({ id: slotId }),
      });
      expect(mine.status).toBe(200);
    });

    it("a rival cannot rewrite another venue's address or capacity", async () => {
      as(uRival);
      const res = await venuePatch(
        new Request("http://test", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Hijacked", capacity: 9 }),
        }),
        { params: Promise.resolve({ id: venueId }) },
      );
      expect(res.status).toBe(403);
      const [v] = await db()
        .select({ name: schema.venues.name })
        .from(schema.venues)
        .where(eq(schema.venues.id, venueId));
      expect(v!.name).toBe("Authz Bar"); // and nothing changed
    });

    // Was the presign route until media went link-only; /api/media/embed is now
    // the only way anything attaches to a profile, so it inherits the check.
    it("a stranger cannot attach media to a profile they don't own", async () => {
      as(uStranger);
      const res = await mediaEmbedPost(
        new Request("http://test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subjectType: "venue",
            url: "https://flickr.com/photos/stranger/1",
          }),
        }),
      );
      expect(res.status).toBe(403);
    });
  });
});
