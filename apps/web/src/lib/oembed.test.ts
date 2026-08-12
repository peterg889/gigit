import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEmbedMeta, normalizeEmbedUrl, providerFor } from "./oembed";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub fetch with one oEmbed payload and report the endpoint it was called with. */
function stubOembed(payload: unknown, ok = true) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return { ok, json: async () => payload } as unknown as Response;
  });
  return calls;
}

describe("embed provider detection", () => {
  it("recognizes YouTube watch and short URLs", () => {
    expect(providerFor("https://www.youtube.com/watch?v=abc123")).toEqual({
      provider: "youtube",
      kind: "video",
    });
    expect(providerFor("https://youtu.be/abc123")).toEqual({
      provider: "youtube",
      kind: "video",
    });
  });

  it("recognizes Vimeo", () => {
    expect(providerFor("https://vimeo.com/12345")).toEqual({
      provider: "vimeo",
      kind: "video",
    });
  });

  it("recognizes the photo hosts", () => {
    expect(providerFor("https://www.flickr.com/photos/act/51234567890")).toEqual({
      provider: "flickr",
      kind: "photo",
    });
    expect(providerFor("https://i.imgur.com/abc123.jpg")).toEqual({
      provider: "imgur",
      kind: "photo",
    });
  });

  it("recognizes the audio hosts, including per-act Bandcamp subdomains", () => {
    expect(providerFor("https://soundcloud.com/act/track")).toEqual({
      provider: "soundcloud",
      kind: "audio",
    });
    expect(providerFor("https://theact.bandcamp.com/track/one")).toEqual({
      provider: "bandcamp",
      kind: "audio",
    });
  });

  it("rejects everything else", () => {
    expect(providerFor("https://example.com/video")).toBeNull();
    expect(providerFor("https://youtube.com.evil.com/watch")).toBeNull();
    // The Bandcamp subdomain rule must not become a generic suffix match.
    expect(providerFor("https://bandcamp.com.evil.com/track/one")).toBeNull();
    expect(providerFor("not a url")).toBeNull();
  });

  it("rejects http, which an on-path attacker can redirect", () => {
    expect(providerFor("http://www.youtube.com/watch?v=abc123")).toBeNull();
  });
});

describe("normalizeEmbedUrl", () => {
  it("drops the fragment so one track cannot be added as ten different URLs", () => {
    expect(normalizeEmbedUrl("https://soundcloud.com/act/track#t=30")).toBe(
      "https://soundcloud.com/act/track",
    );
  });

  it("refuses a URL no provider claims", () => {
    expect(normalizeEmbedUrl("https://example.com/track")).toBeNull();
  });
});

describe("fetchEmbedMeta", () => {
  it("returns the kind alongside the provider", async () => {
    stubOembed({ title: "Live at the Cactus Club", thumbnail_url: "https://i.ytimg.com/vi/a/0.jpg" });
    await expect(fetchEmbedMeta("https://www.youtube.com/watch?v=abc123")).resolves.toEqual({
      provider: "youtube",
      kind: "video",
      title: "Live at the Cactus Club",
      thumbnailUrl: "https://i.ytimg.com/vi/a/0.jpg",
    });
  });

  it("captures the direct image URL from a Flickr photo payload", async () => {
    const calls = stubOembed({
      type: "photo",
      title: "Press shot",
      url: "https://live.staticflickr.com/65535/51234567890_b.jpg",
    });
    const meta = await fetchEmbedMeta("https://www.flickr.com/photos/act/51234567890");
    expect(calls[0]).toContain("https://www.flickr.com/services/oembed/");
    expect(meta).toEqual({
      provider: "flickr",
      kind: "photo",
      title: "Press shot",
      imageUrl: "https://live.staticflickr.com/65535/51234567890_b.jpg",
    });
  });

  it("ignores an image URL that is not on the provider's own CDN", async () => {
    stubOembed({ type: "photo", url: "https://evil.example/pixel.jpg" });
    const meta = await fetchEmbedMeta("https://www.flickr.com/photos/act/51234567890");
    expect(meta).toEqual({ provider: "flickr", kind: "photo" });
  });

  it("uses a direct Imgur link as the image, since Imgur answers with a rich blob", async () => {
    stubOembed({ type: "rich", html: "<blockquote>…</blockquote>" });
    const meta = await fetchEmbedMeta("https://i.imgur.com/abc123.jpg");
    expect(meta).toEqual({
      provider: "imgur",
      kind: "photo",
      imageUrl: "https://i.imgur.com/abc123.jpg",
    });
  });

  it("keeps a Bandcamp link even though Bandcamp publishes no oEmbed endpoint", async () => {
    const calls = stubOembed({ title: "should never be fetched" });
    await expect(fetchEmbedMeta("https://theact.bandcamp.com/track/one")).resolves.toEqual({
      provider: "bandcamp",
      kind: "audio",
    });
    expect(calls).toEqual([]);
  });

  it("treats a metadata failure as non-fatal", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    await expect(fetchEmbedMeta("https://soundcloud.com/act/track")).resolves.toEqual({
      provider: "soundcloud",
      kind: "audio",
    });
  });

  it("returns null for a host no provider claims", async () => {
    await expect(fetchEmbedMeta("https://example.com/track")).resolves.toBeNull();
  });
});
