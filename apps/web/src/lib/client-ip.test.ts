import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

describe("clientIp", () => {
  it("prefers CloudFront's generated viewer address over spoofable XFF", () => {
    const request = new Request("https://example.test", {
      headers: {
        "cloudfront-viewer-address": "198.51.100.42:46532",
        "x-forwarded-for": "203.0.113.99, 198.51.100.42, 54.240.0.1",
      },
    });

    expect(clientIp(request)).toBe("198.51.100.42");
  });

  it("strips the source port from a bracketed IPv6 viewer address", () => {
    const request = new Request("https://example.test", {
      headers: {
        "cloudfront-viewer-address": "[2001:db8::42]:46532",
      },
    });

    expect(clientIp(request)).toBe("2001:db8::42");
  });

  it("uses the viewer position in the CloudFront and ALB fallback chain", () => {
    const request = new Request("http://localhost", {
      headers: {
        "x-forwarded-for": "203.0.113.99, 192.0.2.10, 54.240.0.1",
      },
    });

    expect(clientIp(request)).toBe("192.0.2.10");
  });

  it("accepts a single forwarded address in local tests", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "192.0.2.10" },
    });

    expect(clientIp(request)).toBe("192.0.2.10");
  });
});
