import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { supportTriage } = vi.hoisted(() => ({
  supportTriage: vi.fn().mockResolvedValue({
    reply: "A person will take a look.",
    escalate: true,
    category: "other",
  }),
}));
vi.mock("@gigit/db", async (orig) => ({
  ...(await orig<typeof import("@gigit/db")>()),
  supportTriage,
}));

const sessionUserId = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/support", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify(body),
    }),
  );

describe("public support", () => {
  const signedInUser = newId("user");

  beforeAll(async () => {
    await db().insert(schema.users).values({
      id: signedInUser,
      email: `${signedInUser}@example.test`,
    });
  });
  afterEach(() => {
    sessionUserId.mockResolvedValue(null);
    supportTriage.mockReset().mockResolvedValue({
      reply: "A person will take a look.",
      escalate: true,
      category: "other",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("requires a reply address when no account session is available", async () => {
    const res = await post({ message: "I cannot get into my account." });
    expect(res.status).toBe(422);
  });

  it("accepts and escalates a rate-limited locked-out request", async () => {
    const res = await post({
      email: `locked-out-${Date.now()}@example.test`,
      message: "I deactivated my account and need an erasure review.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ escalated: true });
    expect(body.requestId).toMatch(/^spr_/);
    const [request] = await db()
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.id, body.requestId));
    expect(request).toMatchObject({
      contactEmail: expect.stringMatching(/^locked-out-/),
      channel: "web",
      category: "other",
      escalationReason: "anonymous",
      status: "open",
      message: "I deactivated my account and need an erasure review.",
    });
    const [event] = await db()
      .select()
      .from(schema.events)
      .where(eq(schema.events.subjectId, body.requestId));
    expect(event).toMatchObject({
      kind: "support.escalated",
      subjectType: "support_request",
    });
    expect(event?.payload).not.toHaveProperty("message");
  });

  it("does not let signed-in or SMS escalations consume the public quota", async () => {
    const marker = Date.now();
    await db().insert(schema.events).values(
      Array.from({ length: 100 }, (_, index) => ({
        actor: "system",
        kind: "support.escalated",
        subjectType: "support_request",
        subjectId: `spr_non_public_${marker}_${index}`,
        payload: { channel: index % 2 ? "sms" : "web" },
        dispatchedAt: new Date(),
      })),
    );

    const res = await post({
      email: `quota-${marker}@example.test`,
      message: "I am locked out and still need a way to reach support.",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ escalated: true });
  });

  it("persists an authenticated AI escalation with a contact snapshot", async () => {
    sessionUserId.mockResolvedValue(signedInUser);
    const res = await post({
      message: "I need a person to review a legal issue with a booking.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ escalated: true });
    const [request] = await db()
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.id, body.requestId));
    expect(request).toMatchObject({
      requesterUserId: signedInUser,
      contactEmail: `${signedInUser}@example.test`,
      channel: "web",
      escalationReason: "triage",
      status: "open",
    });
  });

  it("turns an AI triage failure into a durable human escalation", async () => {
    sessionUserId.mockResolvedValue(signedInUser);
    supportTriage.mockRejectedValueOnce(new Error("provider unavailable"));

    const res = await post({
      message: "The help assistant is unavailable but I still need support.",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ escalated: true });
    const [request] = await db()
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.id, body.requestId));
    expect(request).toMatchObject({
      requesterUserId: signedInUser,
      channel: "web",
      category: "other",
      escalationReason: "triage_error",
      status: "open",
    });
  });
});
