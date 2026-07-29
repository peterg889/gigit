/**
 * Effective dates for the legal documents, in one place.
 *
 * The consent event written at sign-in is the artifact you'd produce if someone
 * ever disputed what they agreed to, and it was hardcoded to a date the
 * documents had already moved past — so every recorded consent pointed at a
 * superseded version. The pages and the consent record now read the same
 * constants, and the human label is derived rather than typed twice.
 *
 * Bump the version whose document actually changed. Both are recorded, because
 * the sign-in checkbox covers the Terms and the Privacy Notice together and
 * they don't revise in lockstep.
 */
export const TERMS_VERSION = "2026-07-29";
export const PRIVACY_VERSION = "2026-07-14";
export const COPYRIGHT_VERSION = "2026-07-29";

/** "2026-07-29" → "July 29, 2026" (UTC, so it can't shift by timezone). */
export function effectiveLabel(version: string): string {
  return new Date(`${version}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** What gets stored on the consent event at sign-in. */
export function consentVersions(): {
  termsVersion: string;
  privacyVersion: string;
} {
  return { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };
}
