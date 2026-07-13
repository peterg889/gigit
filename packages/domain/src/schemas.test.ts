import { describe, expect, it } from "vitest";
import { authVerifySchema, venueCreateSchema } from "./schemas.js";

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

describe("sign-in consent", () => {
  it("requires explicit acceptance of the current terms", () => {
    const credentials = { email: "booker@example.test", code: "123456" };
    expect(authVerifySchema.safeParse(credentials).success).toBe(false);
    expect(
      authVerifySchema.safeParse({ ...credentials, termsAccepted: true }).success,
    ).toBe(true);
  });
});
