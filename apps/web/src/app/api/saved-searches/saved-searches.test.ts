import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET as list, POST as create } from "./route";
import { DELETE as remove } from "./[id]/route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const post = (body: Record<string, unknown>) =>
  create(
    new Request("http://test/api/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const del = (id: string) =>
  remove(new Request(`http://test/x/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

/** Saved searches drive new-slot alerts (F2.3) — matching depends on stored shape. */
describe("saved searches", () => {
  const uBand = newId("user");
  const uRival = newId("user");
  const performerId = newId("performer");
  const rivalPerformerId = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values([uBand, uRival].map((id) => ({ id, email: `${id}@t.test` })));
    await d.insert(schema.performers).values([
      {
        id: performerId,
        ownerUserId: uBand,
        kind: "band",
        name: "Search Band",
        homeMetro: "search-tv",
      },
      {
        id: rivalPerformerId,
        ownerUserId: uRival,
        kind: "band",
        name: "Rival",
        homeMetro: "search-tv",
      },
    ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("stores the metro lowercased so worker matching hits (alerts contract)", async () => {
    as(uBand);
    const res = await post({ metro: "Milwaukee", format: "music" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [row] = await db()
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.id, id));
    expect(row?.metro).toBe("milwaukee");
    expect(row?.format).toBe("music");
  });

  it("lists only the caller's searches and deletes only with ownership", async () => {
    as(uBand);
    const mine = await post({ minBudgetCents: 10_000 });
    const { id } = await mine.json();

    const listed = await (await list()).json();
    expect(listed.searches.map((s: { id: string }) => s.id)).toContain(id);

    as(uRival);
    const rivalListed = await (await list()).json();
    expect(rivalListed.searches.map((s: { id: string }) => s.id)).not.toContain(id);
    expect((await del(id)).status).toBe(403);

    as(uBand);
    expect((await del(id)).status).toBe(200);
    expect((await del(id)).status).toBe(404);
  });

  it("requires a performer profile", async () => {
    const uNobody = newId("user");
    await db().insert(schema.users).values({ id: uNobody, email: `${uNobody}@t.test` });
    as(uNobody);
    expect((await post({ metro: "milwaukee" })).status).toBe(403);
    expect((await list()).status).toBe(403);
  });
});
