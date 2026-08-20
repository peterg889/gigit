import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  ACCEPTED_SERVICES,
  MediaManager,
  type MediaItem,
  removeMediaLink,
  submitMediaLink,
} from "./MediaManager";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("React", React);
});

/**
 * EightGig hosts no user media, so this component's whole job is to take a URL.
 * The two things that used to be here — a file input and a PUT to a presigned
 * URL — cannot work at all now, and the accepted-services line is the only
 * warning a user gets before pasting a link we will refuse.
 */
describe("attaching media by link", () => {
  it("offers no file picker anywhere on the form", () => {
    const html = renderToStaticMarkup(<MediaManager subjectType="performer" items={[]} />);

    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/accept="image/);
  });

  it("names every accepted service, grouped by what it holds", () => {
    const html = renderToStaticMarkup(<MediaManager subjectType="venue" items={[]} />);

    // Derived from the domain allow-list, so this also fails if a provider is
    // added there and never surfaces to the person doing the pasting.
    expect(ACCEPTED_SERVICES).toEqual([
      "Photos: Flickr or Imgur",
      "Music: SoundCloud or Bandcamp",
      "Video: YouTube or Vimeo",
    ]);
    for (const line of ACCEPTED_SERVICES) expect(html).toContain(line);
    // and says plainly what will not work, so a refused Dropbox link is not a
    // mystery after the fact
    expect(html).toContain("Dropbox");
  });

  /**
   * /api/media/embed defaults subjectType to "performer". A venue or a tech
   * pasting a photo would otherwise file it against an act profile they may not
   * even have — the failure being "Create an act profile first" while standing
   * on their own venue card.
   */
  it("files the link against the profile the user is standing on", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ id: "med_1", kind: "photo" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitMediaLink(
      "venue",
      "  https://www.flickr.com/photos/room/1/  ",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/media/embed");
    expect(JSON.parse(String(init.body))).toEqual({
      url: "https://www.flickr.com/photos/room/1/",
      subjectType: "venue",
    });
    expect(result).toEqual({ ok: true, message: "Photo added" });
  });

  it("repeats the server's reason for a refusal rather than a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "unsupported_url", message: "That link isn't from a site we support." },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await submitMediaLink("performer", "https://dropbox.com/s/x");

    expect(result).toEqual({
      ok: false,
      message: "That link isn't from a site we support.",
    });
  });
});

/**
 * The manager was add-only, which made the quota refusal ("Remove one to add
 * another") advice about rows the owner could not see, and left a link that was
 * still being screened indistinguishable from one that never attached.
 */
describe("seeing and removing what is attached", () => {
  const items: MediaItem[] = [
    {
      id: "med_ready",
      kind: "video",
      title: "Live at the Cactus Club",
      embedUrl: "https://youtu.be/aaa",
      status: "ready",
    },
    {
      id: "med_held",
      kind: "audio",
      title: null,
      embedUrl: "https://soundcloud.com/act/untitled",
      status: "held",
    },
    {
      id: "med_blocked",
      kind: "photo",
      title: "Room shot",
      embedUrl: "https://flickr.com/photos/act/1",
      status: "blocked",
    },
  ];

  it("lists every attached link with a way to remove each one", () => {
    const html = renderToStaticMarkup(
      <MediaManager subjectType="performer" items={items} />,
    );

    expect(html).toContain("Live at the Cactus Club");
    // No oEmbed title came back for this one, so the link itself is the label —
    // otherwise two untitled tracks are the same row twice and the owner cannot
    // tell which they are about to remove.
    expect(html).toContain("https://soundcloud.com/act/untitled");
    expect(html).toContain("Room shot");
    expect(html.match(/>Remove</g) ?? []).toHaveLength(items.length);
  });

  it("says why a link is not on the public page yet", () => {
    const html = renderToStaticMarkup(
      <MediaManager subjectType="performer" items={items} />,
    );

    expect(html).toContain("being checked — not on your page yet");
    expect(html).toContain("not shown — our review turned this one down");
  });

  it("does not claim an empty profile when the list simply has rows", () => {
    const empty = renderToStaticMarkup(
      <MediaManager subjectType="tech" items={[]} />,
    );
    const full = renderToStaticMarkup(
      <MediaManager subjectType="tech" items={items} />,
    );

    expect(empty).toContain("Nothing attached yet");
    expect(full).not.toContain("Nothing attached yet");
  });

  it("DELETEs the asset by id", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ deleted: true, id: "med_held" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await removeMediaLink("med_held");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/media/med_held");
    expect(init.method).toBe("DELETE");
    expect(result).toEqual({ ok: true, message: "Removed" });
  });

  it("repeats the server's reason for a refused removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "forbidden", message: "That link isn't on a profile you own." },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await removeMediaLink("med_someone_else");

    expect(result).toEqual({
      ok: false,
      message: "That link isn't on a profile you own.",
    });
  });
});
