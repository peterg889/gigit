import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock ONLY constructStripeEvent (no Stripe keys in CI); db/schema stay real.
const { mockConstruct } = vi.hoisted(() => ({ mockConstruct: vi.fn() }));
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  constructStripeEvent: mockConstruct,
}));

import { POST } from "./route";
import { closeDb, db, schema } from "@gigit/db";

const req = (sig: string | null, body = "{}") =>
  new Request("http://test/api/webhooks/stripe", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body,
  });

describe("stripe webhook guards (audit #21)", () => {
  beforeEach(() => mockConstruct.mockReset());
  afterAll(async () => {
    await closeDb();
  });

  it("400 when the signature header is missing — verification isn't even attempted", async () => {
    const res = await POST(req(null));
    expect(res.status).toBe(400);
    expect(mockConstruct).not.toHaveBeenCalled();
  });

  // The bad-signature → 400 branch is covered in route.signature.test.ts
  // against the REAL verifier; a mock that *throws* trips vitest's
  // thrown-error monitor even when the route catches it.

  it("a duplicate event id is an idempotent no-op {duplicate:true}", async () => {
    const id = `evt_dup_${Date.now()}`;
    await db().insert(schema.webhookEvents).values({ id, provider: "stripe" });
    mockConstruct.mockReturnValue({
      id,
      type: "payment_intent.succeeded",
      data: { object: { metadata: {} } },
    });
    const res = await POST(req("t=1,v1=x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true });
  });

  it("an unknown event type is RECORDED (never dropped) and acknowledged {received:true}", async () => {
    const id = `evt_unk_${Date.now()}`;
    mockConstruct.mockReturnValue({ id, type: "invoice.whatever", data: { object: {} } });
    const res = await POST(req("t=1,v1=x"));
    expect(await res.json()).toEqual({ received: true });
    const [row] = await db()
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.id, id));
    expect(row).toBeTruthy();
  });
});
