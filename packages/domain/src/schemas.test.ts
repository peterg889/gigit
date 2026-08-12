import { describe, expect, it } from "vitest";
import {
  authVerifySchema,
  embedCreateSchema,
  embedProviderFor,
  techUpdateSchema,
  venueCreateSchema,
  venueUpdateSchema,
} from "./schemas.js";

const venue = {
  kind: "bar" as const,
  name: "The Room",
  metro: "milwaukee",
  addressLine1: "123 Main St",
  city: "Milwaukee",
  region: "WI",
  postalCode: "53202",
  timeZone: "America/Chicago",
};

describe("venue profile validation", () => {
  it("accepts a normal address without asking an owner for coordinates", () => {
    const parsed = venueCreateSchema.parse(venue);
    expect(parsed.lat).toBeUndefined();
    expect(parsed.lng).toBeUndefined();
  });

  it("normalizes metro names so natural capitalization still matches", () => {
    const parsed = venueCreateSchema.parse({ ...venue, metro: " Milwaukee " });
    expect(parsed.metro).toBe("milwaukee");
  });

  it("rejects invented or misspelled IANA timezones", () => {
    expect(
      venueCreateSchema.safeParse({ ...venue, timeZone: "Central Time" }).success,
    ).toBe(false);
  });

  it("requires enough address data to tell people where the gig is", () => {
    const { addressLine1: _omitted, ...missingAddress } = venue;
    expect(venueCreateSchema.safeParse(missingAddress).success).toBe(false);
  });
});

describe("profile update clearing", () => {
  it("accepts explicit nulls only for nullable PATCH fields", () => {
    expect(venueUpdateSchema.parse({ capacity: null })).toEqual({ capacity: null });
    expect(techUpdateSchema.parse({ rateLaborCents: null })).toEqual({ rateLaborCents: null });
    expect(venueCreateSchema.safeParse({ ...venue, capacity: null }).success).toBe(false);
  });
});

describe("sign-in consent", () => {
  it("requires explicit acceptance of the current terms", () => {
    const credentials = { email: "booker@example.test", code: "123456" };
    expect(authVerifySchema.safeParse(credentials).success).toBe(false);
    expect(
      authVerifySchema.safeParse({ ...credentials, termsAccepted: true }).success,
    ).toBe(true);
  });
});

describe("embed host allow-list", () => {
  const accepts = (url: string) => embedCreateSchema.safeParse({ url }).success;

  it("accepts a link from every supported provider", () => {
    expect(accepts("https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(accepts("https://vimeo.com/12345")).toBe(true);
    expect(accepts("https://www.flickr.com/photos/act/51234567890")).toBe(true);
    expect(accepts("https://i.imgur.com/abc123.jpg")).toBe(true);
    expect(accepts("https://soundcloud.com/act/track")).toBe(true);
    // Bandcamp gives every act its own subdomain.
    expect(accepts("https://theact.bandcamp.com/track/one")).toBe(true);
  });

  it("reports the media kind, which decides how the profile renders the link", () => {
    expect(embedProviderFor("https://i.imgur.com/abc123.jpg")).toEqual({
      provider: "imgur",
      kind: "photo",
    });
    expect(embedProviderFor("https://soundcloud.com/act/track")).toEqual({
      provider: "soundcloud",
      kind: "audio",
    });
    expect(embedProviderFor("https://youtu.be/abc123")).toEqual({
      provider: "youtube",
      kind: "video",
    });
  });

  it("refuses any host outside the list: an open URL field is an SSRF probe", () => {
    expect(accepts("https://example.com/photo.jpg")).toBe(false);
    expect(accepts("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(accepts("https://youtube.com.evil.com/watch")).toBe(false);
    expect(accepts("https://bandcamp.com.evil.com/track/one")).toBe(false);
    // A userinfo prefix makes the host read like an allowed one to the eye.
    expect(accepts("https://www.youtube.com@evil.com/watch")).toBe(false);
  });

  it("refuses http, where an on-path attacker picks the real destination", () => {
    expect(accepts("http://www.youtube.com/watch?v=abc123")).toBe(false);
  });
});
