import type { NextConfig } from "next";

import { type EmbedProvider, embedProviders } from "@gigit/domain";

/**
 * Every host a provider is allowed to serve rendered bytes from — the page the
 * user linked, plus the CDN that provider hands back in its oEmbed payload
 * (i.ytimg.com, farm9.staticflickr.com, i1.sndcdn.com, …).
 *
 * This is the CSP half of the allow-list whose storage half is
 * EMBED_PROVIDER_HOSTS in @gigit/domain and whose fetch half is ASSET_DOMAINS
 * in lib/oembed.ts. It has to be its own list because the three cover different
 * things: a link is *stored* as flickr.com but the image *renders* from
 * staticflickr.com, and neither list contains a player origin for frame-src.
 * next.config.test.ts asserts every provider in `embedProviders` appears here,
 * so adding a seventh provider fails loudly instead of shipping a profile page
 * whose photos are silently blocked by the browser.
 */
const PROVIDER_HOSTS: Record<EmbedProvider, readonly string[]> = {
  youtube: ["youtube.com", "youtube-nocookie.com", "ytimg.com"],
  vimeo: ["vimeo.com", "vimeocdn.com"],
  flickr: ["flickr.com", "staticflickr.com"],
  imgur: ["imgur.com"],
  soundcloud: ["soundcloud.com", "sndcdn.com"],
  bandcamp: ["bandcamp.com", "bcbits.com"],
};

/**
 * Both the bare domain and its subdomains: CSP host-source matching is not
 * suffix matching, so `*.ytimg.com` alone would block `ytimg.com` and
 * `ytimg.com` alone would block `i.ytimg.com`.
 */
const providerSources = (): string[] =>
  embedProviders.flatMap((provider) =>
    PROVIDER_HOSTS[provider].flatMap((host) => [
      `https://${host}`,
      `https://*.${host}`,
    ]),
  );

/**
 * The app served no third-party content when it hosted its own media, so it
 * shipped no CSP at all. Now every photo on a profile is an <img> pointing at
 * somebody else's CDN and every track/video is a link or player from one, which
 * makes the browser the last line of defence if a provider response — or a bug
 * in our own allow-list handling — ever puts an unexpected origin in a src.
 *
 * `unsafe-inline` in script-src is Next's App Router requirement, not a choice:
 * it streams RSC payloads through inline `self.__next_f.push(...)` scripts with
 * no nonce unless a middleware mints one per request, and there is no
 * middleware here. It is still worth shipping the rest — `object-src 'none'`,
 * `base-uri 'self'`, `frame-ancestors 'none'` and a closed img-src/frame-src
 * are what actually matter for a page rendering remote media.
 */
export function contentSecurityPolicy(dev: boolean): string {
  const providers = providerSources();
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // dev only: the Next dev server compiles with eval and hot-reloads over a
    // websocket. Neither is present in a production build.
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // Inline `style={{…}}` attributes on profile and slot pages; CSP has no
    // hash form that covers style attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
    // data: is the inlined SVG noise texture in globals.css, not user content.
    "img-src": ["'self'", "data:", ...providers],
    "frame-src": [...providers],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(dev ? ["ws:"] : [])],
    // We host no media and render no <audio>/<video> element: a track is a link
    // to the provider. If that ever changes this line has to change with it.
    "media-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

const nextConfig: NextConfig = {
  // keep server-only packages out of the client bundle
  serverExternalPackages: ["pg", "pg-boss"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            // Next bakes these into routes-manifest.json at build time, and
            // `next build` forces NODE_ENV=production — so a deployed image
            // always carries the strict policy no matter what NODE_ENV the
            // container is later started with (the e2e harness runs the
            // production build under NODE_ENV=test).
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(process.env.NODE_ENV !== "production"),
          },
          // Referrers leak profile ids to every provider CDN a page pulls from.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
