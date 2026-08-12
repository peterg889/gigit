import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ACCEPTED_SERVICES, MediaManager, submitMediaLink } from "./MediaManager";

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
    const html = renderToStaticMarkup(<MediaManager subjectType="performer" />);

    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/accept="image/);
  });

  it("names every accepted service, grouped by what it holds", () => {
    const html = renderToStaticMarkup(<MediaManager subjectType="venue" />);

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
