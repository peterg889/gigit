import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./ai.js";

/**
 * SSRF guard for user-supplied ingestion URLs (profile link-in onboarding).
 * The old guard missed link-local (cloud metadata 169.254.169.254) and IPv6,
 * and followed redirects without re-checking — so a public URL could bounce
 * into the private range. assertPublicUrl is now applied to every hop.
 */
describe("assertPublicUrl (SSRF guard)", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/", // AWS/GCP metadata — the classic target
    "http://127.0.0.1/",
    "http://localhost/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://100.64.0.1/", // CGNAT
    "http://[::1]/", // IPv6 loopback
    "http://[fd00::1]/", // IPv6 unique-local
    "http://0.0.0.0/",
    "ftp://example.com/", // non-http(s)
    "file:///etc/passwd",
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toThrow(/refusing to fetch/);
    });
  }

  it("allows a public IP literal", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});
