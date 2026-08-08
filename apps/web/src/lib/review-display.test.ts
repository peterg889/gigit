import { describe, expect, it } from "vitest";
import { averageOverall } from "./review-display";

describe("profile star average", () => {
  /**
   * A 0 here would render as "★ 0.0 (0)" on a brand-new profile — a real-looking
   * bad rating for someone nobody has reviewed yet. Callers gate the badge on
   * null, so the empty case must not be a number.
   */
  it("returns null with no visible reviews rather than a zero rating", () => {
    expect(averageOverall([])).toBeNull();
  });

  it("averages the overall score of the visible reviews", () => {
    expect(
      averageOverall([
        { ratings: { overall: 5, punctuality: 1 } },
        { ratings: { overall: 4 } },
      ]),
    ).toBe(4.5);
  });

  it("counts a legacy review with no overall score as zero, not NaN", () => {
    expect(averageOverall([{ ratings: { overall: 4 } }, { ratings: {} }])).toBe(
      2,
    );
  });
});
