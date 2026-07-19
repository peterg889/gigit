import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    });
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
