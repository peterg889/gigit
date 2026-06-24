import { describe, expect, it } from "vitest";
import { disputeBriefSystem } from "./ai.js";

/** Deterministic, no live model: the payments-OFF brief must propose no money. */
describe("disputeBrief system prompt is payments-aware (audit #7)", () => {
  it("payments-OFF: non-monetary, no fee schedule", () => {
    const s = disputeBriefSystem(false);
    expect(s).toMatch(/non-monetary/i);
    expect(s).not.toMatch(/50%/);
    expect(s).not.toMatch(/100%/);
    expect(s).not.toMatch(/>14d/);
  });
  it("payments-ON: proposes amounts and the cancellation fee schedule", () => {
    const s = disputeBriefSystem(true);
    expect(s).toMatch(/partial split/i);
    expect(s).toMatch(/50%/);
    expect(s).toMatch(/100%/);
  });
});
