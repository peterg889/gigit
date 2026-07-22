import { describe, expect, it } from "vitest";
import { BOOKING_STATES } from "./booking/states.js";
import {
  isReviewableBookingState,
  REVIEWABLE_BOOKING_STATES,
  visibleReviews,
} from "./reviews.js";

const now = new Date("2026-06-12T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe("double-blind review visibility (F7.1)", () => {
  it("hides a fresh one-sided review", () => {
    const reviews = [{ bookingId: "b1", authorRole: "venue", createdAt: daysAgo(1) }];
    expect(visibleReviews(reviews, "venue", now)).toHaveLength(0);
  });

  it("shows both once both sides have reviewed, immediately", () => {
    const reviews = [
      { bookingId: "b1", authorRole: "venue", createdAt: daysAgo(0) },
      { bookingId: "b1", authorRole: "performer", createdAt: daysAgo(0) },
    ];
    expect(visibleReviews(reviews, "venue", now)).toHaveLength(1);
    expect(visibleReviews(reviews, "performer", now)).toHaveLength(1);
  });

  it("shows a one-sided review after the 7-day window", () => {
    const reviews = [{ bookingId: "b1", authorRole: "venue", createdAt: daysAgo(8) }];
    expect(visibleReviews(reviews, "venue", now)).toHaveLength(1);
  });

  it("exactly 7 days is still hidden (strictly older required)", () => {
    const reviews = [{ bookingId: "b1", authorRole: "venue", createdAt: daysAgo(7) }];
    expect(visibleReviews(reviews, "venue", now)).toHaveLength(0);
  });

  it("counterpart on a DIFFERENT booking does not unlock", () => {
    const reviews = [
      { bookingId: "b1", authorRole: "venue", createdAt: daysAgo(1) },
      { bookingId: "b2", authorRole: "performer", createdAt: daysAgo(1) },
    ];
    expect(visibleReviews(reviews, "venue", now)).toHaveLength(0);
  });
});

describe("completed-gig review eligibility (F7.1/F7.2)", () => {
  it("allows only full or partial performance outcomes", () => {
    expect([...REVIEWABLE_BOOKING_STATES]).toEqual([
      "released",
      "partially_released",
    ]);

    expect(
      BOOKING_STATES.filter((state) => isReviewableBookingState(state)),
    ).toEqual(["released", "partially_released"]);
  });

  it.each([
    "offered",
    "confirming",
    "confirmed",
    "awaiting_confirmation",
    "disputed",
    "collapsed",
    "cancelled_by_venue",
    "cancelled_by_performer",
    "refunded",
  ] as const)("rejects %s because it is not a completed gig", (state) => {
    expect(isReviewableBookingState(state)).toBe(false);
  });
});
