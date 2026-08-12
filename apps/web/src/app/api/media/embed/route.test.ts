import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

// Control the session per case (the route's requireUser() still runs against the
// real DB for the suspension check). This is the reusable web-route auth pattern.
const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const add = (body: unknown) =>
  POST(
    new Request("http://test/api/media/embed", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

/**
 * The embed route is now the ONLY way media reaches a profile — the presign /
 * upload / complete path is gone with the bucket it wrote to. So it has to
 * carry photos and audio, not just the YouTube/Vimeo video it was written for,
 * and it has to keep the two things the upload path enforced: you can only add
 * to a profile you own, and you cannot add an unbounded number.
 */
describe("media embed — every kind is a link", () => {
  const userId = newId("user");
  const performerId = newId("performer");
  const venueOwnerId = newId("user");
  const venueId = newId("venue");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: userId, email: `${userId}@t.test` },
      { id: venueOwnerId, email: `${venueOwnerId}@t.test` },
    ]);
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: userId,
      kind: "band",
      name: "The Bishops",
      homeMetro: "mke",
    });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Lakefront Taproom",
      metro: "mke",
      lat: 43,
      lng: -88,
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    // Every provider oEmbed call in this file answers from here — no network.
    vi.stubGlobal("fetch", async () =>
      Response.json({ type: "photo", title: "Soundcheck", url: "https://live.staticflickr.com/1/2.jpg" }),
    );
    sessionUserId.mockResolvedValue(userId);
  });
  afterEach(async () => {
    sessionUserId.mockResolvedValue(userId);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  const assetsOf = (subjectId: string) =>
    db().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.subjectId, subjectId));

  it.each([
    ["https://flickr.com/photos/band/12345", "photo", "flickr"],
    ["https://soundcloud.com/thebishops/live", "audio", "soundcloud"],
    ["https://thebishops.bandcamp.com/track/one", "audio", "bandcamp"],
    ["https://youtu.be/dQw4w9WgXcQ", "video", "youtube"],
  ])("accepts %s as a %s link", async (url, kind, provider) => {
    // performerOwnedBy resolves the caller's OWN act, so give each case a
    // caller with exactly one act and assert against that act's assets.
    const caller = newId("user");
    const subjectId = newId("performer");
    await db().insert(schema.users).values({ id: caller, email: `${caller}@t.test` });
    await db().insert(schema.performers).values({
      id: subjectId,
      ownerUserId: caller,
      kind: "band",
      name: `Act ${subjectId}`,
      homeMetro: "mke",
    });
    sessionUserId.mockResolvedValue(caller);

    const res = await add({ url });
    expect(res.status).toBe(201);
    const [asset] = await assetsOf(subjectId);
    expect(asset!.kind).toBe(kind); // the provider decides the kind, not the client
    expect(asset!.embedMeta?.provider).toBe(provider);
    // Nothing is public until the worker's screen says so (F7.5).
    expect(asset!.status).toBe("held");
  });

  it("stores the canonical URL, not the paste (fragment stripped)", async () => {
    const caller = newId("user");
    const subjectId = newId("performer");
    await db().insert(schema.users).values({ id: caller, email: `${caller}@t.test` });
    await db().insert(schema.performers).values({
      id: subjectId,
      ownerUserId: caller,
      kind: "band",
      name: "Canonical",
      homeMetro: "mke",
    });
    sessionUserId.mockResolvedValue(caller);
    const res = await add({ url: "https://SoundCloud.com/act/track#t=30" });
    expect(res.status).toBe(201);
    const [asset] = await assetsOf(subjectId);
    expect(asset!.embedUrl).toBe("https://soundcloud.com/act/track");
  });

  it("rejects a link no provider claims (an arbitrary URL is not media)", async () => {
    const res = await add({ url: "https://evil.test/pwn.jpg" });
    expect(res.status).toBe(422);
  });

  it("attaches to a venue the caller owns when asked", async () => {
    sessionUserId.mockResolvedValue(venueOwnerId);
    const res = await add({
      url: "https://flickr.com/photos/venue/999",
      subjectType: "venue",
    });
    expect(res.status).toBe(201);
    const [asset] = await assetsOf(venueId);
    expect(asset!.subjectType).toBe("venue");
    expect(asset!.kind).toBe("photo");
  });

  it("403s a caller with no profile of that type (ownership check survives)", async () => {
    // userId owns an act but no venue.
    const res = await add({
      url: "https://flickr.com/photos/nope/1",
      subjectType: "venue",
    });
    expect(res.status).toBe(403);
  });

  it("enforces the per-kind quota (5 videos), and counts kinds separately", async () => {
    const caller = newId("user");
    const subjectId = newId("performer");
    await db().insert(schema.users).values({ id: caller, email: `${caller}@t.test` });
    await db().insert(schema.performers).values({
      id: subjectId,
      ownerUserId: caller,
      kind: "band",
      name: "Quota",
      homeMetro: "mke",
    });
    sessionUserId.mockResolvedValue(caller);
    for (let i = 0; i < 5; i += 1)
      expect((await add({ url: `https://youtu.be/vid${i}` })).status).toBe(201);

    const over = await add({ url: "https://youtu.be/vid5" });
    expect(over.status).toBe(422);
    expect((await over.json()).error.code).toBe("quota");

    // A photo is not a video: the audio/photo budget is untouched by five videos.
    expect((await add({ url: "https://flickr.com/photos/q/1" })).status).toBe(201);
  });

  it("401s when not signed in", async () => {
    sessionUserId.mockResolvedValue(null);
    expect((await add({ url: "https://youtu.be/anon" })).status).toBe(401);
  });
});
