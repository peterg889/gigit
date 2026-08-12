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
        subjectType: "tech",
        status: "ready",
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
});
