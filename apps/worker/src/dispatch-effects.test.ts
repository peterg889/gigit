import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the payment gateway; everything else (db, outbox) stays real so the
// dispatch routing is exercised end to end.
const { fake } = vi.hoisted(() => ({
  fake: { charge: vi.fn(), transfer: vi.fn(), refund: vi.fn() },
}));
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  paymentGateway: () => fake,
}));

import type PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { drainOutboxOnce } from "./index.js";

const noBoss = {} as unknown as PgBoss;

/**
 * dispatchEvent is where outbox effects become gateway calls — and outbox.test
 * only feeds synthetic no-op/poison events, so the money routing (which method
 * each effect kind invokes, with what args, and the fee/refund > 0 guards) was
 * untested (audit testgaps). These synthetic booking.transition events carry a
 * neutral `to`, so only the effect loop runs.
 */
describe("worker money-effect dispatch routing (audit testgaps)", () => {
  const venueOwner = newId("user");
  const performerOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");

  beforeAll(async () => {
    await db().insert(schema.users).values([
      { id: venueOwner, email: `${venueOwner}@dispatch.test` },
      { id: performerOwner, email: `${performerOwner}@dispatch.test` },
    ]);
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwner,
      kind: "bar",
      name: "Dispatch Room",
      metro: "dispatch-test",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwner,
      kind: "band",
      name: "Dispatch Act",
      homeMetro: "dispatch-test",
    });
  });

  beforeEach(async () => {
    fake.charge.mockReset().mockResolvedValue({ status: "pending", paymentRef: "pi_x" });
    fake.transfer.mockReset().mockResolvedValue(undefined);
    fake.refund.mockReset().mockResolvedValue(undefined);
    // park any prior backlog so a drain only sees the event we inject
    await getPool().query(
      `update events set dispatched_at = now()
       where dispatched_at is null and dead_lettered_at is null`,
    );
  });
  afterAll(async () => {
    await closeDb();
  });

  async function dispatchEffects(subjectId: string, effects: unknown[]) {
    await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('worker','booking.transition','booking',$1,$2::jsonb)`,
      [subjectId, JSON.stringify({ to: "neutral", effects })],
    );
    await drainOutboxOnce(noBoss);
  }

  async function confirmingBooking(startsAt: Date) {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "dispatch-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirming",
      offerExpiresAt: startsAt,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    return { bookingId, slotId };
  }

  it("release_funds → gateway.transfer(booking, amount)", async () => {
    await dispatchEffects("bkg_rel", [{ kind: "release_funds", amountCents: 5_000 }]);
    expect(fake.transfer).toHaveBeenCalledWith("bkg_rel", 5_000);
    expect(fake.refund).not.toHaveBeenCalled();
  });

  it("refund_funds → gateway.refund(booking, amount)", async () => {
    await dispatchEffects("bkg_ref", [{ kind: "refund_funds", amountCents: 3_000 }]);
    expect(fake.refund).toHaveBeenCalledWith("bkg_ref", 3_000);
    expect(fake.transfer).not.toHaveBeenCalled();
  });

  it("executes a booking adjustment with the same operation key on every replay", async () => {
    const bookingId = "bkg_adjustment_replay";
    const operationKey = "ops-refund-replay-1";
    const { rows } = await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ('ops','booking.adjustment','booking',$1,$2::jsonb)
       returning id`,
      [
        bookingId,
        JSON.stringify({
          effects: [
            {
              kind: "refund_funds",
              amountCents: 4_000,
              operationKey,
            },
          ],
        }),
      ],
    );

    await drainOutboxOnce(noBoss);
    await getPool().query(
      `update events set dispatched_at = null where id = $1`,
      [rows[0]!.id],
    );
    await drainOutboxOnce(noBoss);

    expect(fake.refund).toHaveBeenCalledTimes(2);
    expect(fake.refund).toHaveBeenNthCalledWith(
      1,
      bookingId,
      4_000,
      operationKey,
    );
    expect(fake.refund).toHaveBeenNthCalledWith(
      2,
      bookingId,
      4_000,
      operationKey,
    );
  });

  it("keeps same-amount intentional transfers distinct at the gateway seam", async () => {
    await dispatchEffects("bkg_two_adjustments", [
      { kind: "release_funds", amountCents: 5_000, operationKey: "ops-pay-1" },
      { kind: "release_funds", amountCents: 5_000, operationKey: "ops-pay-2" },
    ]);

    expect(fake.transfer).toHaveBeenNthCalledWith(
      1,
      "bkg_two_adjustments",
      5_000,
      "ops-pay-1",
    );
    expect(fake.transfer).toHaveBeenNthCalledWith(
      2,
      "bkg_two_adjustments",
      5_000,
      "ops-pay-2",
    );
  });

  it("cancellation_fee splits into transfer(fee) + refund(refund), honoring the > 0 guards", async () => {
    await dispatchEffects("bkg_fee", [
      { kind: "cancellation_fee", feeCents: 4_000, refundCents: 0 },
    ]);
    expect(fake.transfer).toHaveBeenCalledWith("bkg_fee", 4_000);
    expect(fake.refund).not.toHaveBeenCalled(); // refundCents 0 → no refund call

    fake.transfer.mockClear();
    await dispatchEffects("bkg_fee2", [
      { kind: "cancellation_fee", feeCents: 0, refundCents: 6_000 },
    ]);
    expect(fake.transfer).not.toHaveBeenCalled(); // feeCents 0 → no transfer call
    expect(fake.refund).toHaveBeenCalledWith("bkg_fee2", 6_000);
  });

  it("request_payment → gateway.charge(booking); a pending result defers to the webhook", async () => {
    const { bookingId } = await confirmingBooking(
      new Date(Date.now() + 7 * 86_400_000),
    );
    await dispatchEffects(bookingId, [{ kind: "request_payment" }]);
    expect(fake.charge).toHaveBeenCalledWith(bookingId);
    // pending → no transfer/refund and no follow-on transition here
    expect(fake.transfer).not.toHaveBeenCalled();
    expect(fake.refund).not.toHaveBeenCalled();
  });

  it("carries a synchronous gateway payment reference into the atomic transition", async () => {
    const paymentRef = `pi_worker_${newId("booking")}`;
    fake.charge.mockResolvedValueOnce({ status: "succeeded", paymentRef });
    const { bookingId } = await confirmingBooking(
      new Date(Date.now() + 8 * 86_400_000),
    );
    await dispatchEffects(bookingId, [{ kind: "request_payment" }]);

    const [booking] = await db()
      .select({ state: schema.bookings.state, paymentRef: schema.bookings.paymentRef })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    expect(booking).toEqual({ state: "confirmed", paymentRef });
    const [charge] = await db()
      .select({ paymentRef: schema.ledgerEntries.paymentRef })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.bookingId, bookingId));
    expect(charge?.paymentRef).toBe(paymentRef);
  });

  it("skips charging and closes confirming when the request reaches downbeat late", async () => {
    const { bookingId, slotId } = await confirmingBooking(
      new Date(Date.now() - 60_000),
    );
    await dispatchEffects(bookingId, [{ kind: "request_payment" }]);
    expect(fake.charge).not.toHaveBeenCalled();

    const [booking] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    expect(booking!.state).toBe("collapsed");
    const [slot] = await db()
      .select({ status: schema.slots.status })
      .from(schema.slots)
      .where(eq(schema.slots.id, slotId));
    expect(slot!.status).toBe("expired");
  });
});
