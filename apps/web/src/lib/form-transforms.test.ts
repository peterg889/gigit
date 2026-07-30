import { describe, expect, it } from "vitest";
import { applyTransform } from "./form-transforms";

describe("form transforms", () => {
  it("venueGear groups the house-sound fields into paInventory", () => {
    const body = applyTransform(
      {
        name: "Lakefront Taproom",
        hasPA: "true",
        mixerChannels: 8,
        micsAvailable: 2,
        monitors: 1,
        hasOperator: "false",
      },
      "venueGear",
    );
    expect(body).toEqual({
      name: "Lakefront Taproom",
      paInventory: {
        hasPA: true,
        mixerChannels: 8,
        micsAvailable: 2,
        monitors: 1,
        hasOperator: false,
      },
    });
  });

  it("venueGear records an explicit 'no PA' answer (not just a missing field)", () => {
    // Regression: the room genuinely without a PA must be distinguishable from
    // a venue that was never asked — the sound plan and the public venue page
    // both read this value.
    const body = applyTransform({ hasPA: "false" }, "venueGear");
    expect(body.paInventory).toEqual({ hasPA: false });
  });

  it("venueGear leaves paInventory alone when no sound fields were submitted", () => {
    const body = applyTransform({ name: "Just a rename" }, "venueGear");
    expect(body).toEqual({ name: "Just a rename" });
    expect(body.paInventory).toBeUndefined();
  });

  it("performerProfile groups tech needs and parses list fields", () => {
    const body = applyTransform(
      {
        name: "The Hollow Points",
        genreTags: "roots, rock , ",
        setLengthsMinutes: "45, 60, x, -3",
        inputs: 10,
        micsNeeded: 4,
        monitorsNeeded: 2,
        canPlayUnamplified: "true",
      },
      "performerProfile",
    );
    expect(body.genreTags).toEqual(["roots", "rock"]);
    expect(body.setLengthsMinutes).toEqual([45, 60]);
    expect(body.techNeeds).toEqual({
      inputs: 10,
      micsNeeded: 4,
      monitorsNeeded: 2,
      canPlayUnamplified: true,
    });
    expect(body.inputs).toBeUndefined();
  });

  it("ratings transforms nest the score fields", () => {
    expect(applyTransform({ overall: 5 }, "ratingsOverall").ratings).toEqual({ overall: 5 });
    expect(
      applyTransform({ overall: 4, draw: 5, hospitality: 3 }, "ratingsMulti").ratings,
    ).toEqual({ overall: 4, draw: 5, hospitality: 3 });
  });

  it("genreTagsCsv splits without touching anything else", () => {
    const body = applyTransform({ genreTags: "punk,  soul", other: "kept" }, "genreTagsCsv");
    expect(body).toEqual({ genreTags: ["punk", "soul"], other: "kept" });
  });

  it("no transform leaves the body untouched", () => {
    const body = applyTransform({ hasPA: "true", inputs: 3 });
    expect(body).toEqual({ hasPA: "true", inputs: 3 });
  });
});

/**
 * The house-sound question can now be left unanswered ("Not sure yet"), which
 * ApiForm submits as nothing. That is what lets the sound plan return `unknown`
 * instead of asserting "there is nobody" on the venue's behalf — the form used to
 * default to "false" and so the unknown verdict could never fire from real input.
 */
describe("venueGear leaves unanswered questions out", () => {
  it("omits hasOperator entirely when it was not answered", () => {
    const body: Record<string, unknown> = { hasPA: "true", mixerChannels: 8 };
    applyTransform(body, "venueGear");
    expect(body.paInventory).toEqual({ hasPA: true, mixerChannels: 8 });
    expect(Object.keys(body.paInventory as object)).not.toContain("hasOperator");
  });

  it("keeps an explicit No, which is a real answer and not the same thing", () => {
    const body: Record<string, unknown> = { hasPA: "true", hasOperator: "false" };
    applyTransform(body, "venueGear");
    expect(body.paInventory).toEqual({ hasPA: true, hasOperator: false });
  });

  it("keeps an explicit Yes", () => {
    const body: Record<string, unknown> = { hasPA: "true", hasOperator: "true" };
    applyTransform(body, "venueGear");
    expect(body.paInventory).toEqual({ hasPA: true, hasOperator: true });
  });
});
