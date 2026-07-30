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

/**
 * The format defaulted to `dateStyle: "medium"` — "Jul 24, 2026, 8:00 PM": no
 * weekday, and a year on every date in a 90-day feed. For a bar gig the weekday
 * is the decision.
 */
describe("gig date format", () => {
  const chicago = "America/Chicago";

  it("leads with the weekday and drops the year for a nearby date", () => {
    const soon = new Date(Date.now() + 14 * 86_400_000);
    const out = formatVenueDateTime(soon, chicago);
    expect(out).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? /);
    expect(out).not.toMatch(/\b20\d\d\b/);
    expect(out).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  });

  it("brings the year back when the date is far enough out to be ambiguous", () => {
    const farOut = new Date(Date.now() + 400 * 86_400_000);
    expect(formatVenueDateTime(farOut, chicago)).toMatch(/\b20\d\d\b/);
  });

  it("still honours an explicit dateStyle for archival surfaces", () => {
    const d = new Date("2026-07-24T20:00:00Z");
    expect(formatVenueDateTime(d, chicago, "medium")).toContain("2026");
  });
});
