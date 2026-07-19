import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const cancel = (id: string) =>
  POST(new Request(`http://test/api/bookings/${id}/cancel`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

/**
 * The cancel route picks the state-machine event from who is calling and what
 * state the booking is in (decline vs cancel) — routing that had no direct
 * test although it decides reliability strikes and slot reopening.
 */
describe("booking cancel route", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uOther = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let seq = 0;

  async function makeBooking(advanceTo?: "confirmed") {
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + (10 + seq++) * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "cancel-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
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
    if (advanceTo === "confirmed") {
      await runBookingTransition(bookingId, { kind: "PERFORMER_ACCEPTED" }, uBand);
      await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker");
    }
    return { bookingId, slotId };
  }

  const bookingState = async (id: string) =>
    (
      await db()
        .select({ state: schema.bookings.state })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, id))
    )[0]?.state;

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand, uOther].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Cancel Bar",
      metro: "cancel-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Cancel Band",
      homeMetro: "cancel-tv",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("venue cancelling an offered booking withdraws the offer (collapsed) and reopens the slot", async () => {
    const { bookingId, slotId } = await makeBooking();
    as(uVenue);
    const res = await cancel(bookingId);
    expect(res.status).toBe(200);
    expect(await bookingState(bookingId)).toBe("collapsed");
    const [slot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    expect(slot?.status).toBe("open");
    // withdrawn offer returns the application to submitted so it can be retried
    const [app] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.slotId, slotId));
    expect(app?.status).toBe("submitted");
  });

  it("performer cancelling an offered booking is a decline (application withdrawn)", async () => {
    const { bookingId, slotId } = await makeBooking();
    as(uBand);
    const res = await cancel(bookingId);
    expect(res.status).toBe(200);
    expect(await bookingState(bookingId)).toBe("collapsed");
    const [app] = await db()
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(eq(schema.applications.slotId, slotId));
    expect(app?.status).toBe("withdrawn");
  });

  it("venue cancelling a confirmed booking lands cancelled_by_venue with a strike", async () => {
    const { bookingId } = await makeBooking("confirmed");
    const before = (
      await db()
        .select({ s: schema.venues.reliabilityStrikes })
        .from(schema.venues)
        .where(eq(schema.venues.id, venueId))
    )[0]!.s;
    as(uVenue);
    const res = await cancel(bookingId);
    expect(res.status).toBe(200);
    expect(await bookingState(bookingId)).toBe("cancelled_by_venue");
    const after = (
      await db()
        .select({ s: schema.venues.reliabilityStrikes })
        .from(schema.venues)
        .where(eq(schema.venues.id, venueId))
    )[0]!.s;
    expect(after).toBe(before + 1);
  });

  it("performer cancelling a confirmed booking lands cancelled_by_performer", async () => {
    const { bookingId } = await makeBooking("confirmed");
    as(uBand);
    const res = await cancel(bookingId);
    expect(res.status).toBe(200);
    expect(await bookingState(bookingId)).toBe("cancelled_by_performer");
  });

  it("rejects a non-party with 403 and changes nothing", async () => {
    const { bookingId } = await makeBooking();
    as(uOther);
    const res = await cancel(bookingId);
    expect(res.status).toBe(403);
    expect(await bookingState(bookingId)).toBe("offered");
  });
});
