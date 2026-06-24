import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";

// Mock ONLY constructStripeEvent; db/schema/runBookingTransition stay real so
// the webhook actually drives the booking state machine.
const { mockConstruct } = vi.hoisted(() => ({ mockConstruct: vi.fn() }));
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  constructStripeEvent: mockConstruct,
}));

import { POST } from "./route";
import { closeDb, createOffer, db, runBookingTransition, schema } from "@gigit/db";

const send = () =>
  POST(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=ok" },
      body: "{}",
    }),
  );

const bookingState = async (id: string) =>
  (await db().select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0]?.state;

/**
 * The webhook is "the only path from Stripe into the state machine," yet no test
 * drove a real payment into it (audit testgaps): existing tests used empty
 * metadata, so the transition never ran. Cover the succeeded→confirmed,
 * failed→collapsed, and stale→swallowed branches end to end.
 */
describe("stripe webhook → booking state machine dispatch", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");

  beforeEach(() => mockConstruct.mockReset());
  afterAll(async () => {
    await closeDb();
  });

  async function ensureSeed() {
    const d = db();
    await d
      .insert(schema.users)
      .values([uVenue, uBand].map((id) => ({ id, email: `${id}@t.test` })))
      .onConflictDoNothing();
    await d
      .insert(schema.venues)
      .values({ id: venueId, ownerUserId: uVenue, kind: "bar", name: "WH Bar", metro: "wh-tv", lat: 43, lng: -88 })
      .onConflictDoNothing();
    await d
      .insert(schema.performers)
      .values({ id: performerId, ownerUserId: uBand, kind: "band", name: "WH Band", homeMetro: "wh-tv" })
      .onConflictDoNothing();
  }

  /** A booking parked in `confirming`, waiting on the payment outcome. */
  async function confirmingBooking(): Promise<string> {
    await ensureSeed();
    const d = db();
    const slotId = newId("slot");
    const appId = newId("application");
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "wh-tv",
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
    return bookingId; // now in `confirming`
  }

  it("payment_intent.succeeded with a real bookingId advances confirming → confirmed", async () => {
    const bookingId = await confirmingBooking();
    expect(await bookingState(bookingId)).toBe("confirming");
    mockConstruct.mockReturnValue({
      id: `evt_ok_${bookingId}`,
      type: "payment_intent.succeeded",
      data: { object: { metadata: { bookingId } } },
    });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(await bookingState(bookingId)).toBe("confirmed");
  });

  it("payment_intent.payment_failed collapses the booking", async () => {
    const bookingId = await confirmingBooking();
    mockConstruct.mockReturnValue({
      id: `evt_fail_${bookingId}`,
      type: "payment_intent.payment_failed",
      data: { object: { metadata: { bookingId }, last_payment_error: { code: "card_declined" } } },
    });
    expect((await send()).status).toBe(200);
    expect(await bookingState(bookingId)).toBe("collapsed");
  });

  it("a stale succeeded delivery for an already-confirmed booking is swallowed (200, no change)", async () => {
    const bookingId = await confirmingBooking();
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker"); // already confirmed
    mockConstruct.mockReturnValue({
      id: `evt_stale_${bookingId}`,
      type: "payment_intent.succeeded",
      data: { object: { metadata: { bookingId } } },
    });
    expect((await send()).status).toBe(200); // IllegalTransitionError swallowed, not re-thrown
    expect(await bookingState(bookingId)).toBe("confirmed");
  });
});
