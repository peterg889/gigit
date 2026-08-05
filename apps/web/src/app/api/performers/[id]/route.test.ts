import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET, PATCH } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://test/api/performers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/** Profile edits feed matching (metro/rates), so the update path matters. */
describe("performer profile route", () => {
  const uOwner = newId("user");
  const uOther = newId("user");
  const performerId = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uOwner, uOther].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uOwner,
      kind: "band",
      name: "Patch Band",
      homeMetro: "patch-tv",
      rateMinCents: 10000,
      rateMaxCents: 50000,
    });
  });
  beforeEach(async () => {
    as(null);
    await db()
      .update(schema.performers)
      .set({
        name: "Patch Band",
        homeMetro: "patch-tv",
        rateMinCents: 10000,
        rateMaxCents: 50000,
        bio: "Saved profile copy",
        genreTags: ["rock"],
        setLengthsMinutes: [60, 90],
      })
      .where(eq(schema.performers.id, performerId));
  });
  afterAll(async () => {
    await closeDb();
  });

  it("public GET projects only public fields", async () => {
    const res = await GET(new Request("http://t"), {
      params: Promise.resolve({ id: performerId }),
    });
    const { performer } = await res.json();
    expect(performer.name).toBe("Patch Band");
    expect(performer.ownerUserId).toBeUndefined();
    expect(performer.stripeAccountId).toBeUndefined();
  });

  it("owner updates; metro is lowercased by the schema", async () => {
    as(uOwner);
    const res = await patch(performerId, { homeMetro: "Madison", rateMinCents: 15000 });
    expect(res.status).toBe(200);
    const [p] = await db()
      .select()
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p?.homeMetro).toBe("madison");
    expect(p?.rateMinCents).toBe(15000);
  });

  it("rejects a rate floor above the ceiling", async () => {
    as(uOwner);
    const res = await patch(performerId, { rateMinCents: 90000, rateMaxCents: 10000 });
    expect(res.status).toBe(422);
  });

  it("rejects a new floor above the persisted ceiling without changing either rate", async () => {
    as(uOwner);
    const res = await patch(performerId, { rateMinCents: 90000 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation",
        message: "Lowest rate must be at or below the highest rate.",
      },
    });

    const [p] = await db()
      .select({
        rateMinCents: schema.performers.rateMinCents,
        rateMaxCents: schema.performers.rateMaxCents,
      })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p).toEqual({ rateMinCents: 10000, rateMaxCents: 50000 });
  });

  it("rejects a new ceiling below the persisted floor without changing either rate", async () => {
    as(uOwner);
    const res = await patch(performerId, { rateMaxCents: 5000 });
    expect(res.status).toBe(422);

    const [p] = await db()
      .select({
        rateMinCents: schema.performers.rateMinCents,
        rateMaxCents: schema.performers.rateMaxCents,
      })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p).toEqual({ rateMinCents: 10000, rateMaxCents: 50000 });
  });

  it("serializes concurrent partial rate edits so the saved pair stays ordered", async () => {
    as(uOwner);
    await db()
      .update(schema.performers)
      .set({ rateMinCents: 10000, rateMaxCents: 100000 })
      .where(eq(schema.performers.id, performerId));

    const responses = await Promise.all([
      patch(performerId, { rateMinCents: 90000 }),
      patch(performerId, { rateMaxCents: 20000 }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 422]);

    const [p] = await db()
      .select({
        rateMinCents: schema.performers.rateMinCents,
        rateMaxCents: schema.performers.rateMaxCents,
      })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p?.rateMinCents).not.toBeNull();
    expect(p?.rateMaxCents).not.toBeNull();
    expect(p!.rateMinCents!).toBeLessThanOrEqual(p!.rateMaxCents!);
  });

  it("allows either rate bound to be cleared and then updated independently", async () => {
    as(uOwner);

    expect((await patch(performerId, { rateMaxCents: null })).status).toBe(200);
    expect((await patch(performerId, { rateMinCents: 90000 })).status).toBe(200);
    expect((await patch(performerId, { rateMinCents: null })).status).toBe(200);
    expect((await patch(performerId, { rateMaxCents: 5000 })).status).toBe(200);

    const [p] = await db()
      .select({
        rateMinCents: schema.performers.rateMinCents,
        rateMaxCents: schema.performers.rateMaxCents,
      })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p).toEqual({ rateMinCents: null, rateMaxCents: 5000 });
  });

  it("clears optional copy and lists and returns the cleared values on reload", async () => {
    as(uOwner);
    const res = await patch(performerId, {
      bio: "",
      genreTags: [],
      setLengthsMinutes: [],
    });
    expect(res.status).toBe(200);
    const reloaded = await GET(new Request("http://t"), {
      params: Promise.resolve({ id: performerId }),
    });
    const { performer } = await reloaded.json();
    expect(performer).toMatchObject({
      bio: "",
      genreTags: [],
      setLengthsMinutes: [],
    });
  });

  it("non-owner cannot update", async () => {
    as(uOther);
    expect((await patch(performerId, { name: "Hijacked" })).status).toBe(403);
    const [p] = await db()
      .select({ name: schema.performers.name })
      .from(schema.performers)
      .where(eq(schema.performers.id, performerId));
    expect(p?.name).toBe("Patch Band");
  });
});
