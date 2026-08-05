import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
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
