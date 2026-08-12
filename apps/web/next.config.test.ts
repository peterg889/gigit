import { describe, expect, it } from "vitest";

import { embedProviders } from "@gigit/domain";

import nextConfig, { contentSecurityPolicy } from "./next.config";

function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe("content security policy", () => {
  const prod = directives(contentSecurityPolicy(false));

  it("locks the page down by default", () => {
    expect(prod["default-src"]).toEqual(["'self'"]);
    expect(prod["object-src"]).toEqual(["'none'"]);
    expect(prod["base-uri"]).toEqual(["'self'"]);
    expect(prod["frame-ancestors"]).toEqual(["'none'"]);
    // We store no user files, so nothing should ever load through <audio>/<video>.
    expect(prod["media-src"]).toEqual(["'none'"]);
  });

  // The whole point of link-only media is that the set of hosts we render is
  // closed. A CSP that renders remote content from anywhere gives that back.
  it.each(["img-src", "frame-src"])("keeps %s closed", (name) => {
    const values = prod[name];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      // `data:` is allowed in img-src alone, for the inlined SVG texture in
      // globals.css. Everywhere else a scheme-source means "any origin".
      if (value === "data:" && name === "img-src") continue;
      if (value === "'self'" || value === "'none'") continue;
      expect(value.startsWith("https://")).toBe(true);
      expect(value).not.toBe("https://*");
    }
    expect(values).not.toContain("'unsafe-inline'");
  });

  // Drift guard: a seventh provider added to the storage allow-list without a
  // CSP entry would store fine and then render as a blocked image.
  it.each(embedProviders)("renders %s media", (provider) => {
    const domain =
      provider === "youtube"
        ? "youtube.com"
        : provider === "bandcamp"
          ? "bandcamp.com"
          : `${provider}.com`;
    expect(prod["img-src"]).toContain(`https://${domain}`);
    expect(prod["img-src"]).toContain(`https://*.${domain}`);
    expect(prod["frame-src"]).toContain(`https://${domain}`);
  });

  it("allows the provider CDNs that oEmbed payloads actually point at", () => {
    // These never appear in a pasted link — they arrive in the provider's JSON
    // and end up in an <img src>, so a policy built only from link hosts blocks
    // every thumbnail on the site.
    for (const cdn of [
      "ytimg.com",
      "vimeocdn.com",
      "staticflickr.com",
      "sndcdn.com",
      "bcbits.com",
    ]) {
      expect(prod["img-src"]).toContain(`https://*.${cdn}`);
    }
  });

  it("keeps dev-server escape hatches out of production", () => {
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(prod["connect-src"]).not.toContain("ws:");
    const dev = directives(contentSecurityPolicy(true));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toContain("ws:");
  });
});

describe("security headers", () => {
  it("sends them on every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const keys = rules[0].headers.map((h) => h.key);
    expect(keys).toContain("Content-Security-Policy");
    expect(keys).toContain("Referrer-Policy");
    expect(keys).toContain("X-Content-Type-Options");
    const csp = rules[0].headers.find(
      (h) => h.key === "Content-Security-Policy",
    )!.value;
    expect(directives(csp)["default-src"]).toEqual(["'self'"]);
  });
});
