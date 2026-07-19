import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the Stripe parse and the transition runner; db/schema stay real so the
// webhook_events idempotency row behavior is exercised against Postgres.
const { mockConstruct, mockTransition } = vi.hoisted(() => ({
  mockConstruct: vi.fn(),
  mockTransition: vi.fn(),
}));
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  constructStripeEvent: mockConstruct,
  runBookingTransition: mockTransition,
}));

import { POST } from "./route";
import { closeDb, db, schema } from "@gigit/db";

const send = () =>
  POST(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=ok" },
      body: "{}",
    }),
  );

const eventRow = async (id: string) =>
  (
    await db()
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.id, id))
  )[0];

/**
 * Regression: the idempotency row is inserted before processing, so a
 * transient processing failure (deadlock, DB blip) must RELEASE the row
 * before the 500 — otherwise Stripe's retry sees "duplicate" and the payment
 * event is lost forever.
 */
describe("stripe webhook idempotency vs transient failures", () => {
  beforeEach(() => {
    mockConstruct.mockReset();
    mockTransition.mockReset();
  });
  afterAll(async () => {
    await closeDb();
  });

  const piEvent = (id: string) => ({
    id,
    type: "payment_intent.succeeded",
    data: { object: { metadata: { bookingId: "bkg_idem_test" } } },
  });

  it("releases the idempotency row on failure so the retry reprocesses", async () => {
    const id = `evt_idem_${Date.now()}`;
    mockConstruct.mockReturnValue(piEvent(id));

    // First delivery: processing fails transiently → 500 to Stripe, row released.
    mockTransition.mockRejectedValueOnce(new Error("deadlock detected"));
    await expect(send()).rejects.toThrow("deadlock detected");
    expect(await eventRow(id)).toBeUndefined();

    // Stripe retry: processes for real this time; row is kept.
    mockTransition.mockResolvedValueOnce({
      bookingId: "bkg_idem_test",
      from: "confirming",
      to: "confirmed",
      effects: [],
    });
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(mockTransition).toHaveBeenCalledTimes(2);
    expect(await eventRow(id)).toBeDefined();

    // A genuine duplicate after success short-circuits without reprocessing.
    const dup = await send();
    expect(await dup.json()).toMatchObject({ duplicate: true });
    expect(mockTransition).toHaveBeenCalledTimes(2);
  });

  it("keeps the row when the transition is merely stale (IllegalTransition)", async () => {
    const id = `evt_stale_${Date.now()}`;
    mockConstruct.mockReturnValue(piEvent(id));
    const { IllegalTransitionError } = await vi.importActual<
      typeof import("@gigit/db")
    >("@gigit/db");
    mockTransition.mockRejectedValueOnce(
      new IllegalTransitionError("released" as never, "PAYMENT_SUCCEEDED"),
    );
    const res = await send();
    expect(res.status).toBe(200);
    expect(await eventRow(id)).toBeDefined();
  });
});
