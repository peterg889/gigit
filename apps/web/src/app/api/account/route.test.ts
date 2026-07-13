import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
const destroySession = vi.fn<() => Promise<void>>();
vi.mock("@/lib/session", () => ({
  sessionUserId: () => sessionUserId(),
  destroySession: () => destroySession(),
}));

import { DELETE } from "./route";

describe("account deactivation", () => {
  const userId = newId("user");

  beforeAll(async () => {
    await db().insert(schema.users).values({
      id: userId,
      email: "leaving@example.test",
      phone: "+14145550123",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("requires a signed-in account", async () => {
    sessionUserId.mockResolvedValue(null);
    expect((await DELETE()).status).toBe(401);
  });

  it("removes login identifiers, locks the account, and clears the session", async () => {
    sessionUserId.mockResolvedValue(userId);
    expect((await DELETE()).status).toBe(200);

    const [user] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(user?.status).toBe("deleted");
    expect(user?.email).toBeNull();
    expect(user?.phone).toBeNull();
    expect(user?.smsOptedOutAt).toBeInstanceOf(Date);
    expect(destroySession).toHaveBeenCalledOnce();
  });
});
