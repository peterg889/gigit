import { describe, expect, it } from "vitest";
import { profileMetadata } from "./profile-metadata";

const NOT_FOUND = { title: "Not found — EightGig" };

describe("profileMetadata", () => {
  it("unfurls a live profile with its own name and bio", () => {
    expect(
      profileMetadata(
        { name: "The Cold Fronts", bio: "Four-piece from Bay View.", status: "live" },
        "live act on EightGig.",
      ),
    ).toEqual({
      title: "The Cold Fronts — EightGig",
      description: "Four-piece from Bay View.",
      openGraph: {
        title: "The Cold Fronts",
        description: "Four-piece from Bay View.",
        type: "profile",
      },
    });
  });

  it("falls back to the role sentence when the bio is empty", () => {
    const meta = profileMetadata(
      { name: "Rec Room", bio: "", status: "live" },
      "books live music on EightGig.",
    );
    expect(meta.description).toBe("Rec Room — books live music on EightGig.");
  });

  it("truncates a long bio to the description budget", () => {
    const meta = profileMetadata(
      { name: "Long Bio", bio: "x".repeat(400), status: "live" },
      "live act on EightGig.",
    );
    expect(meta.description).toBe("x".repeat(155));
  });

  // The crawler that renders a link preview never runs the page body, so this
  // is the only gate standing between a taken-down profile and someone's group
  // chat. Anything that is not exactly "live" has to unfurl as not-found —
  // including a status invented after this was written.
  it.each(["hidden", "suspended", "draft", "pending_review", "some_future_status"])(
    "refuses to unfurl a %s profile",
    (status) => {
      expect(
        profileMetadata({ name: "Taken Down", bio: "Secret bio.", status }, "live act on EightGig."),
      ).toEqual(NOT_FOUND);
    },
  );

  it("refuses to unfurl a profile that does not exist", () => {
    expect(profileMetadata(undefined, "live act on EightGig.")).toEqual(NOT_FOUND);
  });
});
