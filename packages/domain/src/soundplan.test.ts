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
      // hasOperator stated explicitly: omitting it now means "unanswered",
      // which is a different verdict (see the unanswered cases below).
      { hasPA: true, mixerChannels: 12, micsAvailable: 4, monitors: 2, hasOperator: false },
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
    const plan = soundPlan({ hasPA: true, hasOperator: false }, { inputs: 4 });
    expect(plan.verdict).toBe("tech_needed");
    expect(plan.gaps).toContain("no one to run sound");
    expect(plan.gaps.some((g) => g.includes("channels"))).toBe(false);
  });

  describe("unanswered is not the same as no", () => {
    // The whole differentiator used to cry wolf: hasOperator is optional and the
    // act's input count defaults to 0, and both read as a definite no — so a
    // default-configured booking came back tech_needed with the single gap "no
    // one to run sound", on every gig, in a metro with no techs yet.
    it("a fully-specified staffed room with enough channels is covered", () => {
      const plan = soundPlan(
        { hasPA: true, mixerChannels: 8, hasOperator: true },
        { inputs: 4 },
      );
      expect(plan.verdict).toBe("covered");
      expect(plan.gaps).toEqual([]);
    });

    it("a room that never said whether anyone runs sound is unknown, not tech_needed", () => {
      const plan = soundPlan({ hasPA: true, mixerChannels: 8 }, { inputs: 4 });
      expect(plan.verdict).toBe("unknown");
      expect(plan.gaps).toContain("the room hasn't said whether anyone runs sound");
      expect(plan.gaps).not.toContain("no one to run sound");
    });

    it("an act that never listed its inputs is unknown", () => {
      const plan = soundPlan(
        { hasPA: true, mixerChannels: 8, hasOperator: true },
        { inputs: 0 },
      );
      expect(plan.verdict).toBe("unknown");
      expect(plan.gaps).toContain("the act hasn't listed its input count");
    });

    it("a stated `false` still means there is nobody to run sound", () => {
      const plan = soundPlan(
        { hasPA: true, mixerChannels: 8, hasOperator: false },
        { inputs: 4 },
      );
      expect(plan.verdict).toBe("tech_needed");
      expect(plan.gaps).toContain("no one to run sound");
    });

    it("a definite no on the PA still outranks anything unanswered", () => {
      // No room at all beats "we don't know who runs it" — a rig is needed
      // regardless, so this must not soften into `unknown`.
      expect(soundPlan({ hasPA: false }, { inputs: 0 }).verdict).toBe(
        "tech_and_rig_needed",
      );
    });

    it("an acoustic act is covered even with everything else unanswered", () => {
      expect(
        soundPlan({ hasPA: true }, { inputs: 0, canPlayUnamplified: true }).verdict,
      ).toBe("covered");
    });
  });
});