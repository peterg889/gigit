import { describe, expect, it } from "vitest";
import {
  formatAddress,
  formatVenueDateTime,
  venueLocalInputToIso,
  venueLocationIsComplete,
} from "./date-time";

describe("venue-local date and time", () => {
  it("interprets datetime-local values in the venue timezone", () => {
    expect(
      venueLocalInputToIso("2026-07-17T20:00", "America/Chicago"),
    ).toBe("2026-07-18T01:00:00.000Z");
  });

  it("renders the stored instant back at the venue wall-clock time", () => {
    expect(
      formatVenueDateTime(
        "2026-07-18T01:00:00.000Z",
        "America/Chicago",
        "full",
      ),
    ).toContain("Friday, July 17, 2026 at 8:00 PM");
  });

  it("rejects a wall-clock time skipped by daylight saving", () => {
    expect(() =>
      venueLocalInputToIso("2026-03-08T02:30", "America/Chicago"),
    ).toThrow(/does not exist/);
  });
});

describe("venue address", () => {
  it("formats the complete public gig location without empty separators", () => {
    expect(
      formatAddress({
        addressLine1: "1872 N Commerce St",
        addressLine2: null,
        city: "Milwaukee",
        region: "WI",
        postalCode: "53212",
      }),
    ).toBe("1872 N Commerce St · Milwaukee, WI · 53212");
  });

  it("does not treat migration fallback data as a launch-ready location", () => {
    expect(
      venueLocationIsComplete({
        addressLine1: "",
        city: "",
        region: "",
        postalCode: "",
        timeZone: "UTC",
      }),
    ).toBe(false);
  });
});
