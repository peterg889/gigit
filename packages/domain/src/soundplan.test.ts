import { describe, expect, it } from "vitest";
import { soundPlan } from "./soundplan.js";

describe("sound plan v0", () => {
  it("acoustic act in a coffee shop is covered with no PA", () => {
    expect(
      soundPlan({ hasPA: false }, { inputs: 2, canPlayUnamplified: true }).verdict,
    ).toBe("covered");
  });

  it("amplified act + no PA → tech and rig needed", () => {
    expect(soundPlan({ hasPA: false }, { inputs: 6 }).verdict).toBe(
      "tech_and_rig_needed",
    );
  });

  it("adequate staffed house PA → covered", () => {
    expect(
      soundPlan(
        {
          hasPA: true,
          mixerChannels: 16,
          micsAvailable: 6,
          monitors: 4,
          hasOperator: true,
        },
        { inputs: 8, micsNeeded: 4, monitorsNeeded: 2 },
      ).verdict,
    ).toBe("covered");
  });

  it("house PA with nobody to run it → tech needed", () => {
    const plan = soundPlan(
      { hasPA: true, mixerChannels: 12, micsAvailable: 4, monitors: 2 },
      { inputs: 6, micsNeeded: 2, monitorsNeeded: 2 },
    );
    expect(plan.verdict).toBe("tech_needed");
    expect(plan.gaps).toContain("no one to run sound");
  });

  it("severely undersized mixer → bring a rig", () => {
    expect(
      soundPlan(
        { hasPA: true, mixerChannels: 4, hasOperator: true },
        { inputs: 12 },
      ).verdict,
    ).toBe("tech_and_rig_needed");
  });

  it("staffed house PA with an UNSPECIFIED channel count is covered for a small act (unknown ≠ 0 channels)", () => {
    const plan = soundPlan({ hasPA: true, hasOperator: true }, { inputs: 1 });
    expect(plan.verdict).toBe("covered");
    expect(plan.gaps).toHaveLength(0);
  });

  it("unstaffed house PA with unknown channels → tech needed, never a whole rig, and no fabricated channel gap", () => {
    const plan = soundPlan({ hasPA: true }, { inputs: 4 });
    expect(plan.verdict).toBe("tech_needed");
    expect(plan.gaps).toContain("no one to run sound");
    expect(plan.gaps.some((g) => g.includes("channels"))).toBe(false);
  });
});
