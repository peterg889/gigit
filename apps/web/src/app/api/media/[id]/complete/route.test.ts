import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

// Control the session per case (the route's requireUser() still runs against the
// real DB for the suspension check). This is the reusable web-route auth pattern.
const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const completeReq = (id: string) =>
  POST(new Request(`http://test/api/media/${id}/complete`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("media complete — advances uploaded → processing (audit #1)", () => {
  const userId = newId("user");
  const otherUserId = newId("user");

  beforeAll(async () => {
    await db()
      .insert(schema.users)
      .values([
        { id: userId, email: `${userId}@t.test` },
        { id: otherUserId, email: `${otherUserId}@t.test` },
      ]);
  });
  afterAll(async () => {
    await closeDb();
  });

  async function seedAsset(status: string, owner = userId) {
    const id = newId("media");
    await db().insert(schema.mediaAssets).values({
      id,
      ownerUserId: owner,
      subjectType: "performer",
      subjectId: newId("performer"),
      kind: "image",
      storageKey: `k/${id}.jpg`,
      bytes: 1000,
      status,
      position: 0,
    });
    return id;
  }

  const screenEvents = (id: string) =>
    db()
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectType, "media"),
          eq(schema.events.subjectId, id),
          eq(schema.events.kind, "media.screen_requested"),
        ),
      );

  it("advances an 'uploaded' asset to 'processing' and requests screening (the S3 path that used to 409)", async () => {
    sessionUserId.mockResolvedValue(userId);
    const id = await seedAsset("uploaded");
    const res = await completeReq(id);
    expect(res.status).toBe(200);
    const [a] = await db().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
    expect(a!.status).toBe("processing");
    expect(await screenEvents(id)).toHaveLength(1);
  });

  it("is idempotent: completing an already-'processing' asset doesn't re-request screening", async () => {
    sessionUserId.mockResolvedValue(userId);
    const id = await seedAsset("processing");
    const res = await completeReq(id);
    expect(res.status).toBe(200);
    expect(await screenEvents(id)).toHaveLength(0); // no new screen event
  });

  it("404s a non-owner completing someone else's asset (no IDOR)", async () => {
    const id = await seedAsset("uploaded", userId);
    sessionUserId.mockResolvedValue(otherUserId);
    const res = await completeReq(id);
    expect(res.status).toBe(404);
    const [a] = await db().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
    expect(a!.status).toBe("uploaded"); // untouched
  });

  it("401s when not signed in", async () => {
    sessionUserId.mockResolvedValue(null);
    const res = await completeReq(await seedAsset("uploaded"));
    expect(res.status).toBe(401);
  });
});
