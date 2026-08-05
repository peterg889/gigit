import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import {
  VenuePaymentMethodRequiredError,
  closeDb,
  db,
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

import { POST as invite } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const call = (slotId: string, body: unknown) =>
  invite(
    new Request("http://test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: slotId }) },
  );

/**
 * Invite-to-slot. Two shipped notification templates told venues to "send an
 * invite" and no invite endpoint existed — the only action was a free-text DM,
 * after which the act had to go find the slot and apply before the venue could
 * offer at all. Both cold-start nudges dead-ended there.
 */
describe("invite an act to an open date", () => {
  const uVenue = newId("user");
  const uRival = newId("user");
  const uAct = newId("user");
  const uOtherAct = newId("user");
  const venueId = newId("venue");
  const rivalVenueId = newId("venue");
  const performerId = newId("performer");
  const otherPerformerId = newId("performer");
  let seq = 0;

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values(
      [uVenue, uRival, uAct, uOtherAct].map((id) => ({ id, email: `${id}@t.test` })),
    );
    await d.insert(schema.venues).values([
      {
        id: venueId, ownerUserId: uVenue, kind: "bar", name: "Invite Room",
        metro: "inv-tv", lat: 43, lng: -88,
        addressLine1: "1 Main St", city: "Milwaukee", region: "WI",
        postalCode: "53202", timeZone: "America/Chicago",
      },
      {
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
        id: rivalVenueId, ownerUserId: uRival, kind: "bar", name: "Rival Room",
        metro: "inv-tv", lat: 43, lng: -88,
      },
    ]);
    await d.insert(schema.performers).values([
      {
        id: performerId, ownerUserId: uAct, kind: "band",
        name: "Invite Act", homeMetro: "inv-tv",
      },
      {
        id: otherPerformerId, ownerUserId: uOtherAct, kind: "solo",
        name: "Other Invite Act", homeMetro: "inv-tv",
      },
    ]);
  });
  afterEach(() => {
    offerPaymentGate.error = null;
  });
  afterAll(async () => {
    await closeDb();
  });

  async function openSlot() {
    const id = newId("slot");
    await db().insert(schema.slots).values({
      id, venueId, metro: "inv-tv",
      startsAt: new Date(Date.now() + (30 + seq++) * 86_400_000),
      durationMinutes: 120, format: "music", budgetCents: 32_000,
    });
    return id;
  }

  it("creates the application AND the firm offer in one step", async () => {
    const slotId = await openSlot();
    as(uVenue);
    const res = await call(slotId, { performerId });
    expect(res.status).toBe(201);
    const { bookingId, applicationId } = await res.json();

    // The act reviews a firm offer like any other — the terms came from the slot,
    // not from someone typing them into a chat message.
    const [booking] = await db()
      .select({ state: schema.bookings.state, terms: schema.bookings.terms })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    expect(booking!.state).toBe("offered");
    expect(booking!.terms.amountCents).toBe(32_000);

    const [application] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId));
    expect(application!.status).toBe("offered");
  });

  it("does not create an invite when the venue cannot be charged", async () => {
    const slotId = await openSlot();
    offerPaymentGate.error = new VenuePaymentMethodRequiredError(venueId);
    as(uVenue);

    const res = await call(slotId, { performerId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payment_method_required",
        message: expect.stringMatching(/payment method/i),
      },
    });

    const applications = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.slotId, slotId));
    expect(applications).toHaveLength(0);
    const bookings = await db()
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.slotId, slotId));
    expect(bookings).toHaveLength(0);
  });

  it("reuses an application the act already submitted", async () => {
    const slotId = await openSlot();
    const theirs = newId("application");
    await db()
      .insert(schema.applications)
      .values({ id: theirs, slotId, performerId, status: "submitted" });

    as(uVenue);
    const res = await call(slotId, { performerId });
    expect(res.status).toBe(201);
    expect((await res.json()).applicationId).toBe(theirs);

    const all = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.slotId, slotId),
          eq(schema.applications.performerId, performerId),
        ),
      );
    expect(all).toHaveLength(1); // never a duplicate
  });

  it("revives a passed-over application rather than dead-ending", async () => {
    const slotId = await openSlot();
    await db().insert(schema.applications).values({
      id: newId("application"), slotId, performerId,
      status: "declined", declineReason: "slot_filled",
    });
    as(uVenue);
    expect((await call(slotId, { performerId })).status).toBe(201);
  });

  it("does not create an application when another act already holds the offer", async () => {
    const slotId = await openSlot();
    as(uVenue);
    expect((await call(slotId, { performerId })).status).toBe(201);

    const conflict = await call(slotId, { performerId: otherPerformerId });
    expect(conflict.status).toBe(409);
    const otherApplications = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.slotId, slotId),
          eq(schema.applications.performerId, otherPerformerId),
        ),
      );
    expect(otherApplications).toHaveLength(0);
  });

  it("keeps the current holder's application offered when they are re-invited", async () => {
    const slotId = await openSlot();
    as(uVenue);
    const first = await call(slotId, { performerId });
    expect(first.status).toBe(201);
    const { applicationId } = await first.json();

    expect((await call(slotId, { performerId })).status).toBe(409);
    const [application] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.id, applicationId));
    expect(application!.status).toBe("offered");
  });

  it("refuses a date that isn't yours, and one that is no longer open", async () => {
    const slotId = await openSlot();
    as(uRival);
    expect((await call(slotId, { performerId })).status).toBe(403);

    await db()
      .update(schema.slots)
      .set({ status: "filled" })
      .where(eq(schema.slots.id, slotId));
    as(uVenue);
    expect((await call(slotId, { performerId })).status).toBe(409);
  });

  it("refuses an act with no profile and one that is hidden", async () => {
    const slotId = await openSlot();
    as(uVenue);
    expect((await call(slotId, { performerId: newId("performer") })).status).toBe(404);

    const hidden = newId("performer");
    const hiddenOwner = newId("user");
    await db().insert(schema.users).values({ id: hiddenOwner, email: `${hiddenOwner}@t.test` });
    await db().insert(schema.performers).values({
      id: hidden, ownerUserId: hiddenOwner, kind: "solo",
      name: "Hidden Act", homeMetro: "inv-tv", status: "hidden",
    });
    expect((await call(slotId, { performerId: hidden })).status).toBe(404);
  });

  it("refuses a caller with no venue profile", async () => {
    const slotId = await openSlot();
    as(uAct);
    expect((await call(slotId, { performerId })).status).toBe(403);
  });
});
