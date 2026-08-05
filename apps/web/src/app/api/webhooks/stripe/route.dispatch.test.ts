import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { asc, eq } from "drizzle-orm";

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
  let bookingSequence = 0;

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
      .values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago", id: venueId, ownerUserId: uVenue, kind: "bar", name: "WH Bar", metro: "wh-tv", lat: 43, lng: -88 })
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
    const startsAt = new Date(Date.now() + (5 + bookingSequence++) * 86_400_000);
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
      data: { object: { id: `pi_ok_${bookingId}`, metadata: { bookingId } } },
    });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(await bookingState(bookingId)).toBe("confirmed");
    const [persisted] = await db()
      .select({ paymentRef: schema.bookings.paymentRef })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    expect(persisted?.paymentRef).toBe(`pi_ok_${bookingId}`);
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

  it("a success just after payment-window collapse is charged and refunded once", async () => {
    const bookingId = await confirmingBooking();
    const [booking] = await db()
      .select({ terms: schema.bookings.terms })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    const paymentRef = `pi_late_${bookingId}`;
    const afterDownbeat = new Date(
      new Date(booking!.terms.startsAt).getTime() + 1,
    );
    await runBookingTransition(
      bookingId,
      { kind: "PAYMENT_FAILED", reason: "payment_window_closed" },
      "worker",
      afterDownbeat,
    );
    expect(await bookingState(bookingId)).toBe("collapsed");

    mockConstruct.mockReturnValue({
      id: `evt_late_ok_${bookingId}`,
      type: "payment_intent.succeeded",
      data: { object: { id: paymentRef, metadata: { bookingId } } },
    });
    expect((await send()).status).toBe(200);
    expect(await bookingState(bookingId)).toBe("collapsed");
    const money = await db()
      .select({
        type: schema.ledgerEntries.entryType,
        amount: schema.ledgerEntries.amountCents,
        paymentRef: schema.ledgerEntries.paymentRef,
      })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.bookingId, bookingId))
      .orderBy(asc(schema.ledgerEntries.id));
    expect(money).toEqual([
      {
        type: "charge",
        amount: 30_000,
        paymentRef,
      },
      { type: "refund", amount: 30_000, paymentRef: null },
    ]);

    // A differently-ID'd webhook replay for the same PaymentIntent reaches the transition runner, but
    // the prior collapsed→collapsed compensation makes it a stale no-op.
    mockConstruct.mockReturnValue({
      id: `evt_late_replay_${bookingId}`,
      type: "payment_intent.succeeded",
      data: { object: { id: paymentRef, metadata: { bookingId } } },
    });
    expect((await send()).status).toBe(200);
    const afterReplay = await db()
      .select({ id: schema.ledgerEntries.id })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.bookingId, bookingId));
    expect(afterReplay).toHaveLength(2);
  });

  it("a stale succeeded delivery for an already-confirmed booking is swallowed (200, no change)", async () => {
    const bookingId = await confirmingBooking();
    await runBookingTransition(bookingId, { kind: "PAYMENT_SUCCEEDED" }, "worker"); // already confirmed
    mockConstruct.mockReturnValue({
      id: `evt_stale_${bookingId}`,
      type: "payment_intent.succeeded",
      data: { object: { id: `pi_stale_${bookingId}`, metadata: { bookingId } } },
    });
    expect((await send()).status).toBe(200); // IllegalTransitionError swallowed, not re-thrown
    expect(await bookingState(bookingId)).toBe("confirmed");
  });
});
