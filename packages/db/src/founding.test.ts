import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { and, gte, lte } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import * as schema from "./schema.js";
import { FOUNDING_LIMIT, assignFounding, isFoundingMember } from "./founding.js";

/**
 * Founding rank assignment: monotonic per side, member cutoff at FOUNDING_LIMIT,
 * atomic under concurrency, and gap-free on rollback.
 */
describe("founding-member assignment", () => {
  const owners: string[] = [];

  async function makePerformer(): Promise<{ number: number; member: boolean }> {
    const ownerId = newId("user");
    owners.push(ownerId);
    await db().insert(schema.users).values({ id: ownerId, email: `${ownerId}@t.test` });
    return db().transaction(async (tx) => {
      const rank = await assignFounding(tx, "performer");
      await tx.insert(schema.performers).values({
        id: newId("performer"),
        ownerUserId: ownerId,
        kind: "band",
        name: "Founding Test",
        homeMetro: "f-tv",
        foundingNumber: rank.foundingNumber,
        foundingMember: rank.foundingMember,
      });
      return { number: rank.foundingNumber, member: rank.foundingMember };
    });
  }

  afterAll(async () => {
    await closeDb();
  });

  it("isFoundingMember respects the cutoff and null", () => {
    expect(isFoundingMember(1)).toBe(true);
    expect(isFoundingMember(FOUNDING_LIMIT)).toBe(true);
    expect(isFoundingMember(FOUNDING_LIMIT + 1)).toBe(false);
    expect(isFoundingMember(null)).toBe(false);
    expect(isFoundingMember(undefined)).toBe(false);
  });

  it("assigns strictly increasing, distinct numbers", async () => {
    const a = await makePerformer();
    const b = await makePerformer();
    const c = await makePerformer();
    expect(b.number).toBe(a.number + 1);
    expect(c.number).toBe(b.number + 1);
    expect(a.member).toBe(true);
  });

  it("stays gap-free when a creation rolls back", async () => {
    const before = await makePerformer();
    await expect(
      db().transaction(async (tx) => {
        const rank = await assignFounding(tx, "performer");
        expect(rank.foundingNumber).toBe(before.number + 1);
        throw new Error("simulated failure after reserving the rank");
      }),
    ).rejects.toThrow("simulated failure");
    // the burned number is reused, not skipped
    const after = await makePerformer();
    expect(after.number).toBe(before.number + 1);
  });

  it("concurrent assignments never collide (unique index + advisory lock)", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => makePerformer()),
    );
    const numbers = results.map((r) => r.number);
    expect(new Set(numbers).size).toBe(numbers.length); // all distinct
  });

  it("flips foundingMember off past the limit", async () => {
    // Push the performer sequence past the cutoff cheaply: seed a high number,
    // then the next real assignment lands at limit+something.
    const ownerId = newId("user");
    await db().insert(schema.users).values({ id: ownerId, email: `${ownerId}@t.test` });
    await db().insert(schema.performers).values({
      id: newId("performer"),
      ownerUserId: ownerId,
      kind: "solo",
      name: "High Rank",
      homeMetro: "f-tv",
      foundingNumber: FOUNDING_LIMIT + 5,
      foundingMember: false,
    });
    const next = await makePerformer();
    expect(next.number).toBe(FOUNDING_LIMIT + 6);
    expect(next.member).toBe(false);
    // and it's stored as a non-member
    const [row] = await db()
      .select({ m: schema.performers.foundingMember })
      .from(schema.performers)
      .where(
        and(
          gte(schema.performers.foundingNumber, FOUNDING_LIMIT + 6),
          lte(schema.performers.foundingNumber, FOUNDING_LIMIT + 6),
        ),
      );
    expect(row?.m).toBe(false);
  });
});
