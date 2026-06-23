import { describe, expect, it } from "vitest";
import { performerReliability } from "./reliability.js";

describe("performerReliability (PRD F7.3 — the trust layer)", () => {
  it("a brand-new act reads as new, not as zero-reliability", () => {
    const r = performerReliability({ gigsCompleted: 0, cancellations: 0 });
    expect(r.tier).toBe("new");
    expect(r.label).toMatch(/new/i);
    expect(r.label).not.toMatch(/cancellation/i);
  });

  it("gigs with no cancellations reads as reliable, with the count said out loud", () => {
    const r = performerReliability({ gigsCompleted: 8, cancellations: 0 });
    expect(r.tier).toBe("reliable");
    expect(r.label).toBe("8 gigs played · no cancellations");
    expect(r.score).toBe(8);
  });

  it("singular grammar for one gig", () => {
    expect(performerReliability({ gigsCompleted: 1, cancellations: 0 }).label).toBe(
      "1 gig played · no cancellations",
    );
  });

  it("any cancellation flips to mixed and names how many", () => {
    const r = performerReliability({ gigsCompleted: 12, cancellations: 1 });
    expect(r.tier).toBe("mixed");
    expect(r.label).toBe("12 gigs played · 1 cancellation");
  });

  it("scores cancellations far heavier than gigs (a strike outweighs gigs for ranking)", () => {
    const clean = performerReliability({ gigsCompleted: 4, cancellations: 0 });
    const flaky = performerReliability({ gigsCompleted: 6, cancellations: 2 });
    expect(clean.score).toBeGreaterThan(flaky.score); // 4 > 6 - 10
  });

  it("is defensive against garbage input (negatives, fractions)", () => {
    const r = performerReliability({ gigsCompleted: -3, cancellations: 2.9 });
    expect(r.score).toBe(0 - 2 * 5); // clamped to 0 gigs, 2 cancellations
    expect(r.tier).toBe("mixed");
    expect(r.label).toBe("0 gigs played · 2 cancellations");
  });
});
