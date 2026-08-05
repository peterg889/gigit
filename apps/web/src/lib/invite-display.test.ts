import { describe, expect, it } from "vitest";
import { inviteSlotLabel } from "./invite-display";

describe("invite slot labels", () => {
  it("includes date, local time, format, and listed budget", () => {
    const label = inviteSlotLabel({
      startsAt: "2026-08-02T01:00:00.000Z",
      timeZone: "America/Chicago",
      formatLabel: "Live music",
      budgetCents: 27500,
    });

    expect(label).toContain("Aug 1");
    expect(label).toContain("8:00 PM");
    expect(label).toContain("Live music");
    expect(label).toContain("$275");
  });
});
