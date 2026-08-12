import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makePerformer, schema } from "@gigit/db";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import PerformerPage from "./page";

// File-level, not per-describe: unstubbing React at the end of the first
// describe left every later test in this file rendering with no global React.
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

/**
 * `/p/[id]` is the one page that travels on its own: the act sends the link to a
 * booker, the booker pastes it into a group chat. A profile with nothing in it
 * used to greet that booker with two statements of absence — "has not added a
 * bio yet" and "has not added photos, audio, video, or reviews yet" — at the
 * exact moment someone was deciding whether to take a chance on the act. The
 * only person who can fix either is the owner, so they're the only one told.
 */
describe("an act's shareable profile, before they've filled it in", () => {
  const render = async (id: string) =>
    renderToStaticMarkup(await PerformerPage({ params: Promise.resolve({ id }) }));

  it("says nothing to a booker about what the act is missing", async () => {
    const act = await makePerformer({ name: "Bare Profile Act", bio: "" });
    sessionUserId.mockResolvedValue(null);

    const html = await render(act.id);

    expect(html).toContain("Bare Profile Act");
    expect(html).not.toMatch(/has not added/i);
    expect(html).not.toMatch(/no bio yet/i);
    // and it does not push the booker into the owner's editing flow
    expect(html).not.toContain('href="/me"');
  });

  it("asks the owner for the photo and the bio, and says why", async () => {
    const act = await makePerformer({ name: "Own Profile Act", bio: "" });
    sessionUserId.mockResolvedValue(act.ownerUserId);

    const html = await render(act.id);

    expect(html).toMatch(/no bio yet/i);
    // The ask names the action the product actually supports: paste a link.
    // "Add photos, audio, or video" described an uploader that no longer exists.
    expect(html).toMatch(/Link a photo, a track, or a video/i);
    expect(html).toContain('href="/me"');
  });

  it("shows a filled-in bio to everyone and drops the prompt", async () => {
    const act = await makePerformer({
      name: "Filled Profile Act",
      bio: "Four-piece out of Bay View, loud and on time.",
    });
    sessionUserId.mockResolvedValue(act.ownerUserId);

    const html = await render(act.id);

    expect(html).toContain("Four-piece out of Bay View");
    expect(html).not.toMatch(/no bio yet/i);
  });

  /**
   * Acts write their bio in verses and paragraphs — the lineup on one line, the
   * pitch under it. HTML collapses those newlines, so the page a booker pastes
   * into a group chat used to show the whole thing as one unbroken grey block.
   */
  it("keeps the line breaks the act typed into their bio", async () => {
    const act = await makePerformer({
      name: "Formatted Bio Act",
      bio: "Four-piece out of Bay View.\n\nLoud, and on time.",
    });
    sessionUserId.mockResolvedValue(null);

    const html = await render(act.id);

    expect(html).toContain(
      '<p class="user-text">Four-piece out of Bay View.\n\nLoud, and on time.</p>',
    );
  });
});

/**
 * Every asset is now a link on somebody else's server: there is no storage key
 * to sign and no file of ours to stream. What the page renders comes out of
 * embed_url and the metadata the provider volunteered.
 */
describe("an act's media, rendered from links", () => {
  const addMedia = (row: {
    subjectId: string;
    ownerUserId: string;
    kind: string;
    embedUrl: string;
    embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
  }) =>
    db()
      .insert(schema.mediaAssets)
      .values({
        id: newId("media"),
        subjectType: "performer",
        status: "ready",
        ...row,
      });

  const render = async (id: string) =>
    renderToStaticMarkup(await PerformerPage({ params: Promise.resolve({ id }) }));

  it("shows a photo as an image served by the host that holds it", async () => {
    const act = await makePerformer({ name: "Photo Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "photo",
      embedUrl: "https://www.flickr.com/photos/band/51234567890/",
      embedMeta: {
        provider: "flickr",
        title: "At the Cactus Club",
        imageUrl: "https://live.staticflickr.com/65535/51234567890_b.jpg",
      },
    });

    const html = await render(act.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/51234567890_b.jpg"',
    );
    expect(html).toContain('alt="At the Cactus Club"');
  });

  /**
   * A Flickr link whose oEmbed fetch timed out is stored with no imageUrl. It
   * must still reach the booker as a link — an <img> with an empty src would
   * render as a broken picture, and dropping the row hides media the act added.
   */
  it("falls back to a link when the provider gave us no image", async () => {
    const act = await makePerformer({ name: "Unenriched Photo Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "photo",
      embedUrl: "https://imgur.com/gallery/abc123",
      embedMeta: { provider: "imgur" },
    });

    const html = await render(act.id);

    expect(html).toContain('href="https://imgur.com/gallery/abc123"');
    expect(html).not.toContain("<img");
  });

  /**
   * Audio used to be an <audio controls src> pointed at our own bucket. A
   * SoundCloud track is not a file we can hand to that element, so it goes out
   * as a badged link to the page that plays it.
   */
  it("sends a listener to the track's own page instead of a dead player", async () => {
    const act = await makePerformer({ name: "Audio Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "audio",
      embedUrl: "https://soundcloud.com/audio-act/live-at-x",
      embedMeta: { provider: "soundcloud", title: "Live at X" },
    });

    const html = await render(act.id);

    expect(html).toContain("Listen");
    expect(html).toContain('href="https://soundcloud.com/audio-act/live-at-x"');
    expect(html).toContain("Live at X");
    expect(html).toContain("SoundCloud");
    expect(html).not.toContain("<audio");
  });

  it("still shows video, and stops asking the owner for media once there is some", async () => {
    const act = await makePerformer({ name: "Video Act" });
    sessionUserId.mockResolvedValue(act.ownerUserId);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "video",
      embedUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      embedMeta: { provider: "youtube", title: "Whole set, Bay View" },
    });

    const html = await render(act.id);

    expect(html).toContain("Watch");
    expect(html).toContain('href="https://www.youtube.com/watch?v=abcdefghijk"');
    expect(html).toContain("YouTube");
    expect(html).not.toMatch(/Link a photo, a track, or a video/i);
  });
});
