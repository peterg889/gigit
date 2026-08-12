import { newId } from "@gigit/domain";
import { closeDb, db, makePerformer, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as resolvePost } from "./[id]/resolve/route";

const post = (id: string, body: unknown) =>
  resolvePost(
    new Request(`http://test/api/admin/flags/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/**
 * Migration 0033 renamed the media lifecycle when uploads went away
 * (uploaded/processing/ready/rejected → held/ready/blocked) and pinned it with
 * a CHECK constraint. This route kept writing the retired names, which stopped
 * being a silent no-op the moment that constraint existed: a moderator
 * upholding a flag got a 500 and a flag still sitting open.
 *
 * The route is also the ONLY path from `held` to `ready` that a human controls,
 * so if it breaks, screened-out media can never be released by hand.
 */
describe("resolving a media flag speaks the post-0033 vocabulary", () => {
  const admin = newId("user");
  let performerId: string;

  beforeAll(async () => {
    await db().insert(schema.users).values({ id: admin, email: `${admin}@flags.test` });
    await db().insert(schema.actorRoles).values({
      id: newId("role"),
      userId: admin,
      kind: "admin",
    });
    performerId = (await makePerformer({ name: "Flagged Act" })).id;
    sessionUserId.mockResolvedValue(admin);
  });

  afterAll(async () => {
    await closeDb();
  });

  /** A held asset with an open flag on it — what the moderation queue shows. */
  async function flaggedAsset(status: "held" | "ready") {
    const assetId = newId("media");
    // No "flag" prefix exists in newId; fraud_flags ids are minted elsewhere,
    // so borrow the media prefix rather than emit an "undefined_" id.
    const flagId = newId("media");
    await db().insert(schema.mediaAssets).values({
      id: assetId,
      subjectType: "performer",
      subjectId: performerId,
      ownerUserId: admin,
      kind: "photo",
      embedUrl: `https://www.flickr.com/photos/act/${assetId}`,
      status,
    });
    await db().insert(schema.fraudFlags).values({
      id: flagId,
      kind: "ai_screen",
      subjectType: "media",
      subjectId: assetId,
      confidence: 90,
      state: "open",
    });
    return { assetId, flagId };
  }

  const statusOf = async (assetId: string) =>
    (
      await db()
        .select({ status: schema.mediaAssets.status })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, assetId))
    )[0]?.status;

  it("releases held media when the flag is cleared", async () => {
    const { assetId, flagId } = await flaggedAsset("held");
    const res = await post(flagId, { action: "clear" });
    expect(res.status).toBe(200);
    expect(await statusOf(assetId)).toBe("ready");
  });

  it("blocks the media when the flag is upheld, without violating the check", async () => {
    const { assetId, flagId } = await flaggedAsset("ready");
    const res = await post(flagId, { action: "uphold" });
    // The old code wrote 'rejected' here, which the CHECK constraint refuses —
    // so this asserts a 200, not merely that the status changed.
    expect(res.status).toBe(200);
    expect(await statusOf(assetId)).toBe("blocked");
  });
});
