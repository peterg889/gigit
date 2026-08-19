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
  /**
   * `status` is required, deliberately. It used to default to "ready", so no
   * test here ever rendered a venue page holding an unscreened photo — and
   * `eq(schema.mediaAssets.status, "ready")` could be deleted from page.tsx with
   * a green suite.
   */
  const addPhoto = (row: {
    subjectId: string;
    ownerUserId: string;
    status: "held" | "ready" | "blocked";
    embedUrl: string;
    embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
  }) =>
    db()
      .insert(schema.mediaAssets)
      .values({
        id: newId("media"),
        subjectType: "venue",
        kind: "photo",
        ...row,
      });

  const render = async (id: string) =>
    renderToStaticMarkup(await VenuePage({ params: Promise.resolve({ id }) }));

  it("shows the room from the photo host that serves it", async () => {
    const venue = await makeVenue({ name: "Linked Room" });
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      status: "ready",
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
      status: "ready",
      embedUrl: "https://imgur.com/gallery/roomshot",
      embedMeta: { provider: "imgur" },
    });

    const html = await render(venue.id);

    expect(html).toContain('href="https://imgur.com/gallery/roomshot"');
    expect(html).not.toContain("<img");
  });

  /**
   * A venue photo lands `held` and stays there until it is screened (PRD F7.5),
   * because this page is public to anyone with the link and the photo is a URL
   * on a host we don't run. Both unscreened states are seeded here with a
   * screened photo alongside them on the SAME venue, so the photo card is
   * definitely rendering — what's missing is missing because of the status
   * filter, not because the section never opened. Without this, deleting
   * `eq(schema.mediaAssets.status, "ready")` from page.tsx put every held and
   * blocked link on the venue page and broke nothing.
   */
  it("shows the screened photo and neither the held nor the blocked one", async () => {
    const venue = await makeVenue({ name: "Screened Room" });
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      status: "ready",
      embedUrl: "https://www.flickr.com/photos/room/40000000001/",
      embedMeta: {
        provider: "flickr",
        title: "Screened stage corner",
        imageUrl: "https://live.staticflickr.com/65535/40000000001_c.jpg",
      },
    });
    // No imageUrl on either unscreened row on purpose: the page renders those as
    // an <a href> with the provider's title as the link text, so both halves of
    // the assertion below — URL and title — are things the page would really
    // print if the gate were gone. Given an imageUrl it prints the CDN URL
    // instead and the embedUrl assertion could never fail.
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      status: "held",
      embedUrl: "https://imgur.com/gallery/unscreened-room",
      embedMeta: { provider: "imgur", title: "Unscreened back room" },
    });
    await addPhoto({
      subjectId: venue.id,
      ownerUserId: venue.ownerUserId,
      status: "blocked",
      embedUrl: "https://imgur.com/gallery/blocked-room",
      embedMeta: { provider: "imgur", title: "Blocked room shot" },
    });

    const html = await render(venue.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/40000000001_c.jpg"',
    );
    expect(html).not.toContain("unscreened-room");
    expect(html).not.toContain("Unscreened back room");
    expect(html).not.toContain("blocked-room");
    expect(html).not.toContain("Blocked room shot");
  });
});
