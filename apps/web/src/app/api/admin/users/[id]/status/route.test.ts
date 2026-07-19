import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const setStatus = (id: string, status: string) =>
  POST(
    new Request(`http://test/api/admin/users/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id }) },
  );

/** Suspension is the platform's only enforcement lever at launch (F9.1). */
describe("admin user status route", () => {
  const uAdmin = newId("user");
  const uCivilian = newId("user");
  const uTarget = newId("user");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uAdmin, uCivilian, uTarget].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d
      .insert(schema.actorRoles)
      .values({ id: newId("role"), userId: uAdmin, kind: "admin" });
  });
  afterAll(async () => {
    await closeDb();
  });

  const statusOf = async (id: string) =>
    (
      await db()
        .select({ s: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, id))
    )[0]?.s;

  it("suspends and reinstates a user", async () => {
    as(uAdmin);
    expect((await setStatus(uTarget, "suspended")).status).toBe(200);
    expect(await statusOf(uTarget)).toBe("suspended");
    expect((await setStatus(uTarget, "active")).status).toBe(200);
    expect(await statusOf(uTarget)).toBe("active");
  });

  it("rejects a non-admin", async () => {
    as(uCivilian);
    expect((await setStatus(uTarget, "suspended")).status).toBe(403);
    expect(await statusOf(uTarget)).toBe("active");
  });

  it("rejects invalid status values", async () => {
    as(uAdmin);
    expect((await setStatus(uTarget, "deleted")).status).toBe(422);
  });

  it("404s for an unknown user", async () => {
    as(uAdmin);
    expect((await setStatus(newId("user"), "suspended")).status).toBe(404);
  });
});
