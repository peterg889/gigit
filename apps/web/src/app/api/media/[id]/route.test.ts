import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

// Same web-route auth pattern as the embed route's test: the session is the
// only thing stubbed, so requireUser() and all three ownership lookups still
// run against the real database.
const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { DELETE } from "./route";
import { POST } from "../embed/route";

const del = (id: string) =>
  DELETE(new Request(`http://test/api/media/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

const add = (body: unknown) =>
  POST(
    new Request("http://test/api/media/embed", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const assetById = async (id: string) =>
  (
    await db()
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, id))
  )[0];

/** A user with exactly one profile of the given type, so the *OwnedBy lookups resolve to it. */
async function makeOwner(subjectType: "performer" | "venue" | "tech") {
  const userId = newId("user");
  await db().insert(schema.users).values({ id: userId, email: `${userId}@t.test` });
  if (subjectType === "performer") {
    const id = newId("performer");
    await db().insert(schema.performers).values({
      id,
      ownerUserId: userId,
      kind: "band",
      name: `Act ${id}`,
      homeMetro: "mke",
    });
    return { userId, subjectId: id as string };
  }
  if (subjectType === "venue") {
    const id = newId("venue");
    await db().insert(schema.venues).values({
      id,
      ownerUserId: userId,
      kind: "bar",
      name: `Room ${id}`,
      metro: "mke",
      lat: 43,
      lng: -88,
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    return { userId, subjectId: id as string };
  }
  const id = newId("tech");
  await db().insert(schema.techs).values({
    id,
    ownerUserId: userId,
    name: `Tech ${id}`,
    gear: "full_rig",
  });
  return { userId, subjectId: id as string };
}

/** Attach a link directly, so a case can start from a status the POST never writes. */
async function attach(
  subjectType: "performer" | "venue" | "tech",
  subjectId: string,
  ownerUserId: string,
  overrides: { kind?: string; status?: string; embedUrl?: string } = {},
) {
  const id = newId("media");
  await db().insert(schema.mediaAssets).values({
    id,
    ownerUserId,
    subjectType,
    subjectId,
    kind: overrides.kind ?? "video",
    embedUrl: overrides.embedUrl ?? `https://youtu.be/${id}`,
    embedMeta: { provider: "youtube" },
    status: overrides.status ?? "ready",
  });
  return id as string;
}

/**
 * Media is link-only and EightGig stores no files, so removing an asset is a row
 * delete — but it is the row delete the quota message has been promising since
 * the upload path went away ("Remove one to add another"), and the thing that
 * lets someone who pasted the wrong link stop showing it.
 */
describe("removing a media link", () => {
  beforeAll(() => {
    // Every oEmbed lookup the POST path makes in this file answers from here.
    vi.stubGlobal("fetch", async () =>
      Response.json({ type: "video", title: "Live set", provider_name: "YouTube" }),
    );
  });
  beforeEach(() => {
    sessionUserId.mockResolvedValue(null);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  it.each(["performer", "venue", "tech"] as const)(
    "lets the owner of the %s profile the link hangs on remove it",
    async (subjectType) => {
      const { userId, subjectId } = await makeOwner(subjectType);
      const assetId = await attach(subjectType, subjectId, userId);
      sessionUserId.mockResolvedValue(userId);

      const res = await del(assetId);

      expect(res.status).toBe(200);
      expect(await assetById(assetId)).toBeUndefined();
    },
  );

  it.each(["performer", "venue", "tech"] as const)(
    "403s a different owner of the same profile type (%s)",
    async (subjectType) => {
      const mine = await makeOwner(subjectType);
      const stranger = await makeOwner(subjectType);
      const assetId = await attach(subjectType, mine.subjectId, mine.userId);
      // The stranger holds a profile of exactly this type, so the ownership
      // lookup succeeds and only the subjectId comparison stands between them
      // and someone else's profile.
      sessionUserId.mockResolvedValue(stranger.userId);

      const res = await del(assetId);

      expect(res.status).toBe(403);
      expect(await assetById(assetId)).toBeDefined();
    },
  );

  /**
   * The tech branch is the one least exercised elsewhere: a sound tech's media
   * has no add-side test of its own, and an ownership switch that fell through
   * to performerOwnedBy for the third case would look right in every act test.
   */
  it("403s an act owner deleting from a sound tech's profile", async () => {
    const techOwner = await makeOwner("tech");
    const actOwner = await makeOwner("performer");
    const assetId = await attach("tech", techOwner.subjectId, techOwner.userId);
    sessionUserId.mockResolvedValue(actOwner.userId);

    const res = await del(assetId);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(await assetById(assetId)).toBeDefined();
  });

  it("404s an id that names no asset", async () => {
    const { userId } = await makeOwner("performer");
    sessionUserId.mockResolvedValue(userId);

    expect((await del(newId("media"))).status).toBe(404);
  });

  it("401s when not signed in", async () => {
    const { userId, subjectId } = await makeOwner("performer");
    const assetId = await attach("performer", subjectId, userId);

    expect((await del(assetId)).status).toBe(401);
    expect(await assetById(assetId)).toBeDefined();
  });

  /**
   * The whole point of the feature. The quota refusal says "Remove one to add
   * another"; until there was a DELETE that sentence described an action the
   * product did not implement, and a fifth video was permanent.
   */
  it("frees quota: five videos, remove one, and a sixth link attaches", async () => {
    const { userId, subjectId } = await makeOwner("performer");
    sessionUserId.mockResolvedValue(userId);
    for (let i = 0; i < 5; i += 1)
      expect((await add({ url: `https://youtu.be/full${i}` })).status).toBe(201);

    const over = await add({ url: "https://youtu.be/sixth" });
    expect(over.status).toBe(422);
    expect((await over.json()).error.code).toBe("quota");

    const [victim] = await db()
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.subjectId, subjectId));
    expect((await del(victim!.id)).status).toBe(200);

    expect((await add({ url: "https://youtu.be/sixth" })).status).toBe(201);
    const remaining = await db()
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.subjectId, subjectId));
    expect(remaining).toHaveLength(5);
  });

  /**
   * A link the screen held or a moderator refused is invisible on the public
   * page but still spends one of the five video slots, so refusing to delete it
   * would burn that slot forever on something the site will never show — and
   * "I pasted the wrong link and it got held" is the main case for this route.
   */
  it.each(["held", "blocked"] as const)(
    "removes an asset that is %s, not only a published one",
    async (status) => {
      const { userId, subjectId } = await makeOwner("performer");
      const assetId = await attach("performer", subjectId, userId, { status });
      sessionUserId.mockResolvedValue(userId);

      expect((await del(assetId)).status).toBe(200);
      expect(await assetById(assetId)).toBeUndefined();
    },
  );

  /**
   * fraud_flags names its subject by a (subject_type, subject_id) pair with no
   * foreign key behind it, so deleting the asset leaves the ops moderation queue
   * holding a card for something no moderator can open — and whose Clear/Uphold
   * buttons then no-op against the missing row inside flags/[id]/resolve.
   */
  it("closes the open fraud flag on a deleted asset as moot, and leaves settled ones alone", async () => {
    const { userId, subjectId } = await makeOwner("performer");
    const assetId = await attach("performer", subjectId, userId, { status: "held" });
    const openFlag = newId("media");
    const settledFlag = newId("media");
    await db().insert(schema.fraudFlags).values([
      {
        id: openFlag,
        subjectType: "media",
        subjectId: assetId,
        kind: "ai_screen",
        confidence: 90,
        evidence: { reasons: ["title looks like a scam"] },
      },
      {
        id: settledFlag,
        subjectType: "media",
        subjectId: assetId,
        kind: "embed_dead",
        confidence: 80,
        evidence: {},
        state: "upheld",
      },
    ]);
    sessionUserId.mockResolvedValue(userId);

    expect((await del(assetId)).status).toBe(200);

    const flags = Object.fromEntries(
      (
        await db()
          .select({ id: schema.fraudFlags.id, state: schema.fraudFlags.state })
          .from(schema.fraudFlags)
          .where(eq(schema.fraudFlags.subjectId, assetId))
      ).map((f) => [f.id, f.state]),
    );
    // Not 'cleared' and not 'upheld': both of those record a person's verdict,
    // and nobody ever looked at this one.
    expect(flags[openFlag]).toBe("moot");
    // A moderator's decision is not rewritten by the owner tidying up after it.
    expect(flags[settledFlag]).toBe("upheld");
    // Nothing open is left pointing at a row that no longer exists.
    const stillOpen = await db()
      .select()
      .from(schema.fraudFlags)
      .where(
        and(
          eq(schema.fraudFlags.subjectId, assetId),
          eq(schema.fraudFlags.state, "open"),
        ),
      );
    expect(stillOpen).toHaveLength(0);

    const [event] = await db()
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.subjectId, assetId), eq(schema.events.kind, "media.deleted")),
      );
    expect(event).toBeDefined();
    expect(event!.payload.statusWhenDeleted).toBe("held");
  });
});
