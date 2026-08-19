import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makeTech, schema } from "@gigit/db";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);

import TechPage from "./page";

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

/**
 * The tech page carried the same storage-key rendering as the other two: an
 * <img> off a signed URL and an <audio controls> pointed at our bucket. Both
 * are gone — a tech's rig photo and their mix are links on hosts we don't run.
 */
describe("a sound tech's media, rendered from links", () => {
  /**
   * `status` is required, deliberately. It used to default to "ready", so no
   * test here ever rendered a tech page holding an unscreened asset — and
   * `eq(schema.mediaAssets.status, "ready")` could be deleted from page.tsx with
   * a green suite.
   */
  const addMedia = (row: {
    subjectId: string;
    ownerUserId: string;
    kind: string;
    status: "held" | "ready" | "blocked";
    embedUrl: string;
    embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
  }) =>
    db()
      .insert(schema.mediaAssets)
      .values({
        id: newId("media"),
        subjectType: "tech",
        ...row,
      });

  const render = async (id: string) =>
    renderToStaticMarkup(await TechPage({ params: Promise.resolve({ id }) }));

  it("shows a rig photo from the host that serves it and links a mix out", async () => {
    const tech = await makeTech({ name: "Linked Tech" });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "photo",
      status: "ready",
      embedUrl: "https://www.flickr.com/photos/tech/47000000001/",
      embedMeta: {
        provider: "flickr",
        title: "Rig at the Cooperage",
        imageUrl: "https://live.staticflickr.com/65535/47000000001_b.jpg",
      },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/linked-tech/board-mix",
      embedMeta: { provider: "soundcloud", title: "Board mix, four-piece" },
    });

    const html = await render(tech.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/47000000001_b.jpg"',
    );
    expect(html).toContain('href="https://soundcloud.com/linked-tech/board-mix"');
    expect(html).toContain("Board mix, four-piece");
    expect(html).not.toContain("<audio");
  });

  /**
   * The tech page publishes the same link-only media as the other two profiles
   * and screens it the same way: `held` until the AI screen clears it, `blocked`
   * once ops upholds a flag (PRD F7.5). Neither state meant anything to any test
   * before this one — every fixture in the file was born "ready", so deleting
   * `eq(schema.mediaAssets.status, "ready")` from page.tsx published a tech's
   * unscreened rig photo and a blocked mix and broke no test.
   *
   * The screened mix is on the same tech so the media card is certainly
   * rendering; and neither unscreened row carries an imageUrl, so the page would
   * print both their URL and their title as an <a> if the gate were gone — which
   * is what makes both halves of each assertion able to fail.
   */
  it("publishes only the screened asset, never the held or the blocked one", async () => {
    const tech = await makeTech({ name: "Screened Tech" });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/screened-tech/cleared-mix",
      embedMeta: { provider: "soundcloud", title: "Cleared board mix" },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "video",
      status: "held",
      embedUrl: "https://www.youtube.com/watch?v=unscreenedrig",
      embedMeta: { provider: "youtube", title: "Unscreened rig walkthrough" },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "photo",
      status: "blocked",
      embedUrl: "https://imgur.com/gallery/blockedrig",
      embedMeta: { provider: "imgur", title: "Blocked rig photo" },
    });

    const html = await render(tech.id);

    expect(html).toContain('href="https://soundcloud.com/screened-tech/cleared-mix"');
    expect(html).toContain("Cleared board mix");
    expect(html).not.toContain("unscreenedrig");
    expect(html).not.toContain("Unscreened rig walkthrough");
    expect(html).not.toContain("blockedrig");
    expect(html).not.toContain("Blocked rig photo");
  });
});
