import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq, inArray, like, or } from "drizzle-orm";
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

const createdRequestIds = new Set<string>();

// A fresh random IP by default so unrelated cases cannot consume each other's
// per-IP budget; pass one explicitly when the address is the thing under test.
const post = async (body: unknown, ip?: string) => {
  const response = await POST(
    new Request("http://test/api/support", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for":
          ip ?? `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify(body),
    }),
  );
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof payload?.requestId === "string")
    createdRequestIds.add(payload.requestId);
  return response;
};

async function deleteFixtureRequests(ids: string[]) {
  if (ids.length === 0) return;
  await db()
    .delete(schema.supportRequestNotes)
    .where(inArray(schema.supportRequestNotes.supportRequestId, ids));
  await db()
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.subjectType, "support_request"),
        inArray(schema.events.subjectId, ids),
      ),
    );
  await db()
    .delete(schema.supportRequests)
    .where(inArray(schema.supportRequests.id, ids));
}

/** Remove only rows identifiable as fixtures from prior interrupted/repeated runs. */
async function purgePersistedFixtureRequests() {
  const rows = await db()
    .select({ id: schema.supportRequests.id })
    .from(schema.supportRequests)
    .where(
      or(
        like(schema.supportRequests.id, "spr_nonpublic_%"),
        like(schema.supportRequests.id, "spr_public_%"),
        like(
          schema.supportRequests.contactEmail,
          "locked-out-%@example.test",
        ),
        like(schema.supportRequests.contactEmail, "quota-%@example.test"),
        like(schema.supportRequests.contactEmail, "capped-%@example.test"),
        like(schema.supportRequests.contactEmail, "other-%@example.test"),
      ),
    );
  await deleteFixtureRequests(rows.map((row) => row.id));
}

describe("public support", () => {
  const signedInUser = newId("user");

  beforeAll(async () => {
    await purgePersistedFixtureRequests();
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
    await purgePersistedFixtureRequests();
    await deleteFixtureRequests([...createdRequestIds]);
    await db().delete(schema.users).where(eq(schema.users.id, signedInUser));
    createdRequestIds.clear();
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
    // This seeded 100 rows into `events`, which the quota query never reads —
    // an inert fixture in front of an assertion that one ordinary request
    // returns 200, which it would with the quota keyed any way at all,
    // including not keyed. The quota counts `support_requests` rows with a
    // NON-NULL request_ip, so THAT is what has to be seeded to mean anything.
    const marker = Date.now();
    await db()
      .insert(schema.supportRequests)
      .values(
        Array.from({ length: 120 }, (_, index) => ({
          id: `spr_nonpublic_${marker}_${index}`,
          channel: index % 2 ? "sms" : "web",
          escalationReason: "triage",
          message: "escalated by the assistant, not a public submission",
          requestIp: null, // the discriminator: not a public submission
        })),
      );

    // 120 non-public escalations, well past the global cap of 100.
    const res = await post({
      email: `quota-${marker}@example.test`,
      message: "I am locked out and still need a way to reach support.",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ escalated: true });
  });

  it("public submissions DO consume the quota, per IP", async () => {
    // The other half, which nothing asserted: without it, deleting the ip filter
    // entirely would still pass every test in this file.
    const ip = `203.0.113.${Math.floor(Date.now() % 200) + 1}`;
    const marker = Date.now();
    await db()
      .insert(schema.supportRequests)
      .values(
        Array.from({ length: 5 }, (_, index) => ({
          id: `spr_public_${marker}_${index}`,
          channel: "web",
          escalationReason: "anonymous",
          message: "a public submission from this address",
          requestIp: ip,
        })),
      );

    const res = await post(
      {
        email: `capped-${marker}@example.test`,
        message: "This one should be turned away by the per-IP cap.",
      },
      ip,
    );
    expect(res.status).toBe(429);

    // ...and a different address is unaffected — it's per-IP, not global.
    const other = await post(
      {
        email: `other-${marker}@example.test`,
        message: "A different address should still get through fine.",
      },
      "203.0.113.254",
    );
    expect(other.status).toBe(200);
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
