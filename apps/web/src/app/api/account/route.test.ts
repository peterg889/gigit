import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, deactivateAccount, identifierIsBlocked, schema } from "@gigit/db";
import { inArray, eq  } from "drizzle-orm";

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

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("lets a signed-in suspended account deactivate and clears its session", async () => {
    const suspendedUserId = newId("user");
    const performerId = newId("performer");
    await db().insert(schema.users).values({
      id: suspendedUserId,
      email: `${suspendedUserId}@suspended-leaving.test`,
      phone: "+14145550124",
      status: "suspended",
    });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: suspendedUserId,
      kind: "solo",
      name: "Suspended Leaving Act",
      homeMetro: "account-test",
      status: "suspended",
    });

    sessionUserId.mockResolvedValue(suspendedUserId);
    expect((await DELETE()).status).toBe(200);

    const [user] = await db()
      .select({
        status: schema.users.status,
        email: schema.users.email,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .where(eq(schema.users.id, suspendedUserId));
    const [performer] = await db()
      .select({ status: schema.performers.status })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(user).toEqual({ status: "deleted", email: null, phone: null });
    expect(performer?.status).toBe("hidden");
    expect(destroySession).toHaveBeenCalledOnce();
  });
});

/**
 * Self-deactivation is deliberately allowed while suspended — people get to
 * leave — but the suspension has to outlive the account.
 *
 * Deactivation nulls email and phone, and auth/verify identifies a returning
 * user BY those identifiers, so without a durable block a suspended user holding
 * a valid 30-day session could DELETE their account and sign straight back up on
 * the same address as a clean one. That erases the only moderation lever the
 * product has.
 */
describe("a suspension survives the user deleting their own account", () => {
  it("blocks re-registration on the same address, and lets an unsuspended one back", async () => {
    const banned = `banned-${newId("user")}@block.test`;
    const ordinary = `ordinary-${newId("user")}@block.test`;

    // Two accounts leave the same way; only one of them was suspended.
    const bannedId = newId("user");
    const ordinaryId = newId("user");
    await db().insert(schema.users).values([
      { id: bannedId, email: banned, status: "suspended" },
      { id: ordinaryId, email: ordinary },
    ]);

    await deactivateAccount(bannedId);
    await deactivateAccount(ordinaryId);

    // Identifiers are gone from the user row either way — that is the point of
    // deactivating, and it is why the block has to live somewhere else.
    const rows = await db()
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, [bannedId, ordinaryId]));
    expect(rows.every((r) => r.email === null)).toBe(true);

    // The suspended address is remembered as a hash, never in the clear.
    expect(await identifierIsBlocked(banned)).toBe(true);
    expect(await identifierIsBlocked(ordinary)).toBe(false);
    const stored = await db()
      .select({ hash: schema.blockedIdentifiers.identifierHash })
      .from(schema.blockedIdentifiers);
    expect(stored.some((r) => r.hash.includes(banned))).toBe(false);

    // Case folding: a block on foo@x.com must not be walked past as Foo@X.com.
    expect(await identifierIsBlocked(banned.toUpperCase())).toBe(true);
  });
});
