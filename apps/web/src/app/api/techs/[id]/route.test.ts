import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, makeTech, schema, setProfileVisibility } from "@gigit/db";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { GET, PATCH } from "./route";

describe("sound-tech profile clearing", () => {
  const ownerId = newId("user");
  const techId = newId("tech");

  beforeAll(async () => {
    await db().insert(schema.users).values({
      id: ownerId,
      email: `${ownerId}@test.local`,
    });
    await db().insert(schema.techs).values({
      id: techId,
      ownerUserId: ownerId,
      name: "Clearable Engineer",
      gear: "full_rig",
      bio: "Saved experience",
      rateLaborCents: 20_000,
      rateWithRigCents: 40_000,
    });
  });

  afterAll(async () => {
    await db().delete(schema.techs).where(eq(schema.techs.id, techId));
    await db().delete(schema.users).where(eq(schema.users.id, ownerId));
    await closeDb();
  });

  it("persists explicit bio and rate clears on reload", async () => {
    sessionUserId.mockResolvedValue(ownerId);
    const response = await PATCH(
      new Request(`http://test/api/techs/${techId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bio: "",
          rateLaborCents: null,
          rateWithRigCents: null,
        }),
      }),
      { params: Promise.resolve({ id: techId }) },
    );
    expect(response.status).toBe(200);

    const reloaded = await GET(new Request("http://test"), {
      params: Promise.resolve({ id: techId }),
    });
    expect(await reloaded.json()).toMatchObject({
      tech: {
        bio: "",
        rateLaborCents: null,
        rateWithRigCents: null,
      },
    });
  });
});

/**
 * The API half of the tech page's status gate. `/t/[id]` 404s a profile that is
 * no longer live; this route serves the same person's name, rates, gear and
 * experience summary as JSON, and for a long time it did not check the column
 * at all — so a suspended tech kept answering over the API exactly what the page
 * had stopped serving.
 *
 * The status is moved by `setProfileVisibility`, the single writer that both
 * owner deactivation and admin suspend/reinstate go through, so this spans the
 * real writer and the real reader rather than a hand-set fixture column.
 */
describe("a non-live sound tech is 404 over the API too", () => {
  const get = (id: string) =>
    GET(new Request(`http://test/api/techs/${id}`), {
      params: Promise.resolve({ id }),
    });

  afterAll(closeDb);

  it("stops serving rates and profile detail after the owner deactivates", async () => {
    const tech = await makeTech({ name: "API Deactivated Tech", bio: "Ten years of it." });
    await db()
      .update(schema.techs)
      .set({ rateLaborCents: 20_000, rateWithRigCents: 45_000 })
      .where(eq(schema.techs.id, tech.id));

    // Live first — so the 404 below is the status gate, and so the payload this
    // gate withholds is on the record: rates, gear, and the tech's own words.
    const live = await get(tech.id);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      tech: {
        name: "API Deactivated Tech",
        bio: "Ten years of it.",
        gear: "full_rig",
        rateLaborCents: 20_000,
        rateWithRigCents: 45_000,
      },
    });

    await setProfileVisibility(tech.ownerUserId, "hidden");

    const hidden = await get(tech.id);
    expect(hidden.status).toBe(404);
    // The 404 body must not leak what it just refused to serve.
    expect(JSON.stringify(await hidden.json())).not.toContain("API Deactivated Tech");
  });

  it("stops serving while ops has the account suspended", async () => {
    const tech = await makeTech({ name: "API Suspended Tech", bio: "Still here." });
    expect((await get(tech.id)).status).toBe(200);

    await setProfileVisibility(tech.ownerUserId, "suspended");

    const suspended = await get(tech.id);
    expect(suspended.status).toBe(404);
    expect(JSON.stringify(await suspended.json())).not.toContain("API Suspended Tech");
  });
});
