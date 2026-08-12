import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);

import VenuePage from "./page";

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

/**
 * A room photo is a link on a photo host, not a file in our bucket — there is no
 * storage key left to sign. The page renders the image URL the provider itself
 * handed back, which lib/oembed has already pinned to that provider's own CDN.
 */
describe("a venue's room photos, rendered from links", () => {
  const addPhoto = (row: {
    subjectId: string;
    ownerUserId: string;
    embedUrl: string;
    embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
  }) =>
    db()
      .insert(schema.mediaAssets)
      .values({
        id: newId("media"),
        subjectType: "venue",
        kind: "photo",
        status: "ready",
        ...row,
      });

  const render = async (id: string) =>
    renderToStaticMarkup(await VenuePage({ params: Promise.resolve({ id }) }));

  it("shows the room from the photo host that serves it", async () => {
    const venue = await makeVenue({ name: "Linked Room" });
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      embedUrl: "https://www.flickr.com/photos/room/49876543210/",
      embedMeta: {
        provider: "flickr",
        title: "The back room, full",
        imageUrl: "https://live.staticflickr.com/65535/49876543210_c.jpg",
      },
    });

    const html = await render(venue.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/49876543210_c.jpg"',
    );
    expect(html).toContain('alt="The back room, full"');
  });

  /**
   * Imgur answers oEmbed with an embed blob rather than a photo payload, so a
   * gallery link arrives with no image URL at all. Rendering an <img> with no
   * src would show the venue a broken picture; dropping the row would silently
   * lose a photo they added.
   */
  it("links out when the provider handed back no image", async () => {
    const venue = await makeVenue({ name: "Unenriched Room" });
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      embedUrl: "https://imgur.com/gallery/roomshot",
      embedMeta: { provider: "imgur" },
    });

    const html = await render(venue.id);

    expect(html).toContain('href="https://imgur.com/gallery/roomshot"');
    expect(html).not.toContain("<img");
  });
});
