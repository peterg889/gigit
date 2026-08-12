import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";

/**
 * The screen is the only path to `ready`, and it used to have two halves: an
 * embed branch for video and a file branch (magic-byte sniff, sharp re-encode,
 * S3 read/write) for everything else. With media link-only there are no bytes
 * of ours to inspect, so a photo or an audio link has to take the metadata
 * screen too — before this, both fell into the file branch and got rejected as
 * unreadable, which is a press photo that never appears on a profile.
 */
const screen = vi.fn();
vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return { ...actual, mediaFraudScreen: (...a: unknown[]) => screen(...a) };
});

const { recheckEmbeds, screenMedia } = await import("./media.js");

const ownerUserId = newId("user");

async function seed(kind: string, status: string, embedUrl: string) {
  const id = newId("media");
  await db().insert(schema.mediaAssets).values({
    id,
    ownerUserId,
    subjectType: "performer",
    subjectId: newId("performer"),
    kind,
    embedUrl,
    embedMeta: { title: "Live at the Cactus Club", provider: "flickr" },
    status,
    position: 0,
  });
  return id;
}

const statusOf = async (id: string) =>
  (await db().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id)))[0]!.status;

const flagsFor = (id: string, kind: string) =>
  db()
    .select()
    .from(schema.fraudFlags)
    .where(and(eq(schema.fraudFlags.subjectId, id), eq(schema.fraudFlags.kind, kind)));

describe("media screen", () => {
  beforeEach(async () => {
    screen.mockReset();
    screen.mockResolvedValue({ risk: "low", reasons: [] });
    await db()
      .insert(schema.users)
      .values({ id: ownerUserId, email: `${ownerUserId}@t.test` })
      .onConflictDoNothing();
  });
  afterAll(async () => {
    await closeDb();
  });

  it.each(["photo", "audio", "video"])(
    "screens a held %s link on its metadata and publishes it",
    async (kind) => {
      const id = await seed(kind, "held", `https://flickr.com/photos/${kind}`);
      await screenMedia(id);
      expect(await statusOf(id)).toBe("ready");
      expect(screen.mock.calls[0]![0]).toMatchObject({
        kind,
        embedTitle: "Live at the Cactus Club",
        embedProvider: "flickr",
      });
    },
  );

  it("leaves a high-risk link held for the ops queue and flags it", async () => {
    screen.mockResolvedValue({ risk: "high", reasons: ["names an unrelated famous act"] });
    const id = await seed("audio", "held", "https://soundcloud.com/x/high-risk");
    await screenMedia(id);
    expect(await statusOf(id)).toBe("held"); // never public without a human
    expect(await flagsFor(id, "ai_screen")).toHaveLength(1);
  });

  it("no-ops on an asset that is already decided (stale/duplicate event)", async () => {
    const id = await seed("photo", "ready", "https://imgur.com/gallery/stale");
    await screenMedia(id);
    expect(screen).not.toHaveBeenCalled();
  });
});

describe("embed-rot recheck", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    await db()
      .insert(schema.users)
      .values({ id: ownerUserId, email: `${ownerUserId}@t.test` })
      .onConflictDoNothing();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("flags a dead audio link, not just video (the old kind filter skipped it)", async () => {
    const id = await seed("audio", "ready", `https://soundcloud.com/${newId("media")}`);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("soundcloud.com") ? new Response(null, { status: 404 }) : new Response(null),
    );
    const dead = await recheckEmbeds();
    expect(dead).toBeGreaterThan(0);
    expect(await flagsFor(id, "embed_dead")).toHaveLength(1);
  });
});
