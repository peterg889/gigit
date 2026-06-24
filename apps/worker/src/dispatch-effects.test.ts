import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { closeDb, getPool } from "@gigit/db";
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
    await dispatchEffects("bkg_pay", [{ kind: "request_payment" }]);
    expect(fake.charge).toHaveBeenCalledWith("bkg_pay");
    // pending → no transfer/refund and no follow-on transition here
    expect(fake.transfer).not.toHaveBeenCalled();
    expect(fake.refund).not.toHaveBeenCalled();
  });
});
