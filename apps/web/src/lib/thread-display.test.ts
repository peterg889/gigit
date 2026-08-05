import { describe, expect, it } from "vitest";
import { counterpartyLabel, participantLabels } from "./thread-display";

describe("thread participant labels", () => {
  it("keeps the common one-profile case concise", () => {
    const labels = participantLabels([
      { userId: "u1", name: "The Night Owls", role: "act" },
    ]);
    expect(labels.get("u1")).toBe("The Night Owls");
  });

  it("does not hide a person's other profile when they have multiple roles", () => {
    const labels = participantLabels([
      { userId: "u1", name: "Sam Rivera", role: "act" },
      { userId: "u1", name: "Sam Rivera", role: "sound tech" },
      { userId: "u1", name: "The Lantern", role: "venue" },
    ]);
    expect(labels.get("u1")).toBe(
      "Sam Rivera (act / sound tech) · The Lantern (venue)",
    );
  });

  it("derives counterparties from participants, including silent ones", () => {
    const labels = participantLabels([
      { userId: "venue-owner", name: "The Lantern", role: "venue" },
      { userId: "act-owner", name: "The Night Owls", role: "act" },
    ]);
    expect(
      counterpartyLabel(
        ["venue-owner", "act-owner"],
        "venue-owner",
        labels,
      ),
    ).toBe("The Night Owls");
  });
});
