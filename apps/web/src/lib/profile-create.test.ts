import { describe, expect, it } from "vitest";
import { respondProfileCreateError } from "./profile-create";

describe("profile create conflict mapping", () => {
  it("maps a wrapped PostgreSQL uniqueness failure to conflict copy", async () => {
    const response = respondProfileCreateError(
      { cause: { cause: { code: "23505" } } },
      "You already have this profile.",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "You already have this profile.",
      },
    });
  });

  it("does not hide unrelated persistence failures", () => {
    const failure = new Error("database unavailable");
    expect(() =>
      respondProfileCreateError(failure, "You already have this profile."),
    ).toThrow(failure);
  });
});
