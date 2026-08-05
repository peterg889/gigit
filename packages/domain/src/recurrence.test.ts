import { describe, expect, it } from "vitest";
import {
  localDateTimeParts,
  nextOccurrences,
  patternFromFirst,
  zonedDateTimeToDate,
} from "./recurrence.js";

describe("patternFromFirst", () => {
  it("derives weekly pattern", () => {
    // Fri 2026-06-19 20:00 in Chicago
    const p = patternFromFirst(
      new Date("2026-06-20T01:00:00Z"),
      120,
      "weekly",
      "America/Chicago",
    );
    expect(p).toEqual({
      freq: "weekly",
      dayOfWeek: 5,
      firstStartsAt: "2026-06-20T01:00:00.000Z",
      startTimeLocal: "20:00",
      timeZone: "America/Chicago",
      durationMinutes: 120,
    });
  });

  it("derives monthly Nth-weekday pattern", () => {
    // 2026-06-02 is the first Tuesday
    const p = patternFromFirst(
      new Date("2026-06-03T00:00:00Z"),
      90,
      "monthly_dow",
      "America/Chicago",
    );
    expect(p).toEqual({
      freq: "monthly_dow",
      dayOfWeek: 2,
      week: 1,
      firstStartsAt: "2026-06-03T00:00:00.000Z",
      startTimeLocal: "19:00",
      timeZone: "America/Chicago",
      durationMinutes: 90,
    });
  });
});

describe("nextOccurrences weekly", () => {
  const p = patternFromFirst(new Date("2026-06-19T20:00:00Z"), 120, "weekly");
  it("starts with the selected first Friday and never invents a pre-anchor night", () => {
    const occ = nextOccurrences(p, new Date("2026-06-12T00:00:00Z"), 3);
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-06-19T20:00:00.000Z",
      "2026-06-26T20:00:00.000Z",
      "2026-07-03T20:00:00.000Z",
    ]);
  });
  it("includes the anchor just before it, then remains strictly after `after`", () => {
    expect(
      nextOccurrences(p, new Date("2026-06-19T19:59:59.999Z"), 1)[0]
        .toISOString(),
    ).toBe("2026-06-19T20:00:00.000Z");
    expect(
      nextOccurrences(p, new Date("2026-06-19T20:00:00.000Z"), 1)[0]
        .toISOString(),
    ).toBe("2026-06-26T20:00:00.000Z");
  });
});

describe("nextOccurrences monthly_dow", () => {
  it("first Tuesday of each month", () => {
    const p = patternFromFirst(new Date("2026-06-02T19:00:00Z"), 90, "monthly_dow");
    const occ = nextOccurrences(p, new Date("2026-06-12T00:00:00Z"), 3);
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-07-07T19:00:00.000Z",
      "2026-08-04T19:00:00.000Z",
      "2026-09-01T19:00:00.000Z",
    ]);
  });
  it("last Friday (week 5 = last)", () => {
    const occ = nextOccurrences(
      { freq: "monthly_dow", dayOfWeek: 5, week: 5, startTimeUtc: "21:00", durationMinutes: 60 },
      new Date("2026-06-01T00:00:00Z"),
      2,
    );
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-06-26T21:00:00.000Z",
      "2026-07-31T21:00:00.000Z",
    ]);
  });

  it("does not emit matching nth weekdays from months before the selected anchor", () => {
    const p = patternFromFirst(
      new Date("2026-09-01T19:00:00Z"),
      90,
      "monthly_dow",
    );
    const occ = nextOccurrences(p, new Date("2026-07-01T00:00:00Z"), 3);
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-09-01T19:00:00.000Z",
      "2026-10-06T19:00:00.000Z",
      "2026-11-03T19:00:00.000Z",
    ]);
  });

  it("anchors a selected last weekday and crosses the year boundary", () => {
    const lastFriday = patternFromFirst(
      new Date("2026-10-30T21:00:00Z"),
      60,
      "monthly_dow",
    );
    expect(
      nextOccurrences(lastFriday, new Date("2026-08-01T00:00:00Z"), 2)
        .map((d) => d.toISOString()),
    ).toEqual([
      "2026-10-30T21:00:00.000Z",
      "2026-11-27T21:00:00.000Z",
    ]);

    const yearBoundary = patternFromFirst(
      new Date("2027-01-31T20:00:00Z"),
      60,
      "monthly_dow",
    );
    expect(
      nextOccurrences(yearBoundary, new Date("2026-12-01T00:00:00Z"), 3)
        .map((d) => d.toISOString()),
    ).toEqual([
      "2027-01-31T20:00:00.000Z",
      "2027-02-28T20:00:00.000Z",
      "2027-03-28T20:00:00.000Z",
    ]);
  });
});

describe("venue-local recurrence through DST", () => {
  it("keeps a weekly night at the same wall-clock hour", () => {
    const pattern = patternFromFirst(
      new Date("2026-03-07T02:00:00Z"), // Friday 8 PM CST
      120,
      "weekly",
      "America/Chicago",
    );
    const occ = nextOccurrences(pattern, new Date("2026-03-01T00:00:00Z"), 3);
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-03-07T02:00:00.000Z",
      "2026-03-14T01:00:00.000Z",
      "2026-03-21T01:00:00.000Z",
    ]);
  });

  it("resolves a nonexistent spring-forward time past the gap instead of throwing", () => {
    // 2:30 AM does not exist on 2026-03-08 in Chicago (clocks jump 2→3 AM).
    // A throw here once aborted materialization for every series platform-wide.
    const occ = nextOccurrences(
      {
        freq: "weekly",
        dayOfWeek: 0,
        startTimeLocal: "02:30",
        timeZone: "America/Chicago",
        durationMinutes: 60,
      },
      new Date("2026-03-02T00:00:00Z"),
      2,
    );
    expect(occ.map((d) => d.toISOString())).toEqual([
      "2026-03-08T08:30:00.000Z", // the gap night lands at 3:30 AM CDT
      "2026-03-15T07:30:00.000Z", // and the series returns to 2:30 AM after
    ]);
  });

  it("does not backfill a spring-transition occurrence before a later selected anchor", () => {
    const pattern = patternFromFirst(
      new Date("2026-03-15T07:30:00.000Z"),
      60,
      "weekly",
      "America/Chicago",
    );
    expect(
      nextOccurrences(pattern, new Date("2026-03-01T00:00:00.000Z"), 2)
        .map((d) => d.toISOString()),
    ).toEqual([
      "2026-03-15T07:30:00.000Z",
      "2026-03-22T07:30:00.000Z",
    ]);
  });

  it("continues to materialize legacy UTC patterns", () => {
    const occ = nextOccurrences(
      { freq: "weekly", dayOfWeek: 5, startTimeUtc: "20:00", durationMinutes: 60 },
      new Date("2026-06-12T20:00:00Z"),
      1,
    );
    expect(occ[0].toISOString()).toBe("2026-06-19T20:00:00.000Z");
    expect(
      nextOccurrences(
        {
          freq: "weekly",
          dayOfWeek: 5,
          startTimeUtc: "20:00",
          durationMinutes: 60,
        },
        new Date("2026-06-01T00:00:00Z"),
        1,
      )[0].toISOString(),
    ).toBe("2026-06-05T20:00:00.000Z");
  });
});

/**
 * Fall-back was untested everywhere: an ambiguous wall time has two valid
 * instants, and nothing pinned which one we pick. materializeSeries keys its
 * unique index on the resolved instant, so a flip would move a booked gig by an
 * hour AND duplicate the occurrence.
 */
describe("DST fall-back (an hour that happens twice)", () => {
  const CHI = "America/Chicago";
  // US fall-back 2026: Nov 1, 02:00 CDT → 01:00 CST.
  //   1:30 AM CDT = 06:30Z   |   1:30 AM CST = 07:30Z
  const ambiguous = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };

  it("resolves an ambiguous time to the EARLIER instant", () => {
    expect(zonedDateTimeToDate(ambiguous, CHI).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("is stable across calls, which is what series idempotency rests on", () => {
    const first = zonedDateTimeToDate(ambiguous, CHI).getTime();
    for (let i = 0; i < 5; i++)
      expect(zonedDateTimeToDate(ambiguous, CHI).getTime()).toBe(first);
  });

  it("round-trips: the instant we pick reads back as the requested wall time", () => {
    const instant = zonedDateTimeToDate(ambiguous, CHI);
    const parts = localDateTimeParts(instant, CHI);
    expect(parts.hour).toBe(1);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(1);
  });

  it("holds an 8pm gig at 8pm local across the fall-back boundary", () => {
    // The offset changes from -5 to -6, so the UTC instant must shift by an hour
    // while the wall clock stays put — that's the whole point for a weekly night.
    const before = zonedDateTimeToDate(
      { year: 2026, month: 10, day: 25, hour: 20, minute: 0 },
      CHI,
    );
    const after = zonedDateTimeToDate(
      { year: 2026, month: 11, day: 1, hour: 20, minute: 0 },
      CHI,
    );
    expect(before.toISOString()).toBe("2026-10-26T01:00:00.000Z"); // CDT, -5
    expect(after.toISOString()).toBe("2026-11-02T02:00:00.000Z"); // CST, -6
    expect(localDateTimeParts(before, CHI).hour).toBe(20);
    expect(localDateTimeParts(after, CHI).hour).toBe(20);
  });

  it("includes an ambiguous selected anchor once and keeps its wall time afterward", () => {
    const pattern = patternFromFirst(
      new Date("2026-11-01T06:30:00.000Z"),
      60,
      "weekly",
      CHI,
    );
    expect(
      nextOccurrences(pattern, new Date("2026-10-01T00:00:00.000Z"), 3)
        .map((d) => d.toISOString()),
    ).toEqual([
      "2026-11-01T06:30:00.000Z",
      "2026-11-08T07:30:00.000Z",
      "2026-11-15T07:30:00.000Z",
    ]);
  });
});
