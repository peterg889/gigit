/**
 * CloudFront generates this header from the viewer connection, so unlike a
 * viewer-supplied X-Forwarded-For prefix it is safe for abuse-rate keys.
 */
export function clientIp(req: Request): string {
  const viewerAddress = req.headers
    .get("cloudfront-viewer-address")
    ?.trim();
  if (viewerAddress) {
    const bracketedIpv6 = viewerAddress.match(/^\[([^\]]+)](?::\d+)?$/);
    if (bracketedIpv6) return bracketedIpv6[1] ?? "";
    return viewerAddress.replace(/:\d+$/, "");
  }

  // Local/test requests do not traverse CloudFront. In the deployed two-proxy
  // chain ALB appends the edge IP after CloudFront appends the real viewer IP,
  // making the second-to-last address the safe defense-in-depth fallback.
  const forwarded = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwarded.length >= 2) return forwarded.at(-2) ?? "";
  return forwarded[0] ?? "";
}
