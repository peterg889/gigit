/**
 * Embed handling for every media kind (engineering-spec §8: media is link-only).
 * EightGig stores no user files, so a photo, a track and a video are all URLs on
 * a third-party host. The host allow-list lives in @gigit/domain and is enforced
 * by the zod schema; this module normalizes URLs and fetches oEmbed metadata
 * (title/thumbnail, and for photos the image itself) with a short timeout —
 * metadata failure is non-fatal (we keep the URL, retry enrichment later).
 */
import {
  type EmbedProvider,
  type MediaKind,
  embedProviderFor,
} from "@gigit/domain";

export interface EmbedMeta {
  provider: EmbedProvider;
  kind: MediaKind;
  title?: string;
  thumbnailUrl?: string;
  /**
   * Photos only: the direct image URL from the oEmbed payload, because profile
   * pages render a press photo as an <img>. A band's promo shot boxed in a
   * provider iframe is the wrong result — it is the one image a venue looks at.
   */
  imageUrl?: string;
}

/**
 * oEmbed endpoints, or null for a provider that publishes none.
 *
 * Bandcamp is the null case: it has no documented oEmbed endpoint, so a
 * Bandcamp link is stored with its provider and kind and no title. That is the
 * same non-fatal path a timeout takes, so nothing special is needed downstream
 * — guessing an endpoint URL would just make every Bandcamp add wait 4s for a
 * 404.
 */
const OEMBED_ENDPOINT: Record<EmbedProvider, ((url: string) => string) | null> = {
  youtube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  vimeo: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`,
  flickr: (u) => `https://www.flickr.com/services/oembed/?format=json&url=${encodeURIComponent(u)}`,
  imgur: (u) => `https://api.imgur.com/oembed.json?url=${encodeURIComponent(u)}`,
  soundcloud: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  bandcamp: null,
};

/**
 * Where each provider is allowed to serve images from.
 *
 * The allow-list has to cover what we RENDER, not just what we store: the
 * thumbnail and image URLs below arrive in a provider's JSON response, and a
 * compromised or spoofed response would otherwise put an arbitrary remote host
 * in an <img src> on somebody's public profile. Matched as domain suffixes
 * because every one of these is a CDN that spreads across numbered subdomains
 * (farm9.staticflickr.com, i1.sndcdn.com, …).
 */
const ASSET_DOMAINS: Record<EmbedProvider, readonly string[]> = {
  youtube: ["ytimg.com", "youtube.com"],
  vimeo: ["vimeocdn.com", "vimeo.com"],
  flickr: ["staticflickr.com", "flickr.com"],
  imgur: ["imgur.com"],
  soundcloud: ["sndcdn.com", "soundcloud.com"],
  bandcamp: ["bcbits.com", "bandcamp.com"],
};

/**
 * Canonical form of a media link: https, lowercase host, no fragment. The
 * fragment goes because it never identifies the resource to a provider but does
 * let the same track be added ten times as ten "different" URLs.
 */
export function normalizeEmbedUrl(url: string): string | null {
  if (!embedProviderFor(url)) return null;
  const parsed = new URL(url.trim());
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

/** The provider and media kind for a link, or null if no provider claims it. */
export function providerFor(
  url: string,
): { provider: EmbedProvider; kind: MediaKind } | null {
  return embedProviderFor(url);
}

/** True if `candidate` is an https URL on one of `provider`'s own asset CDNs. */
function isProviderAsset(provider: EmbedProvider, candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ASSET_DOMAINS[provider].some((d) => host === d || host.endsWith(`.${d}`));
}

export async function fetchEmbedMeta(url: string): Promise<EmbedMeta | null> {
  const match = embedProviderFor(url);
  if (!match) return null;
  const { provider, kind } = match;
  const base: EmbedMeta = { provider, kind };

  // Imgur answers oEmbed with a "rich" embed blob, never a photo payload, so a
  // direct i.imgur.com/xyz.jpg link would arrive with no image to render at
  // all. That link already cleared the host allow-list, and a path ending in an
  // image extension on the provider's own CDN *is* the image.
  if (kind === "photo" && isProviderAsset(provider, url)) {
    const path = new URL(url).pathname;
    if (/\.(jpe?g|png|gif|webp)$/i.test(path)) base.imageUrl = url;
  }

  const endpoint = OEMBED_ENDPOINT[provider]?.(url);
  if (!endpoint) return base;

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return base;
    const data = (await res.json()) as {
      type?: string;
      title?: string;
      url?: string;
      thumbnail_url?: string;
    };
    const meta: EmbedMeta = { ...base };
    if (data.title) meta.title = data.title;
    if (data.thumbnail_url && isProviderAsset(provider, data.thumbnail_url))
      meta.thumbnailUrl = data.thumbnail_url;
    // oEmbed's photo type carries the full-size image in `url`. Providers that
    // answer with type "rich" (Imgur) hand back an embed blob instead, and we
    // have no direct image — the caller falls back to a link rather than
    // injecting somebody else's HTML into the page.
    if (kind === "photo" && data.type === "photo" && data.url && isProviderAsset(provider, data.url))
      meta.imageUrl = data.url;
    return meta;
  } catch {
    return base;
  }
}
