import { describe, expect, it } from "vitest";
import { isNavLinkActive } from "./NavLink";

const search = (value = "") => new URLSearchParams(value);

describe("isNavLinkActive", () => {
  it("keeps a parent active on detail pages", () => {
    expect(isNavLinkActive("/slots/slot_1", search(), "/slots")).toBe(true);
  });

  it("lets a more-specific sibling route win", () => {
    expect(
      isNavLinkActive("/slots/new", search(), "/slots", ["/slots/new"]),
    ).toBe(false);
    expect(isNavLinkActive("/slots/new", search(), "/slots/new")).toBe(true);
  });

  it("includes href query parameters in current-page matching", () => {
    expect(
      isNavLinkActive(
        "/onboarding",
        search("role=venue"),
        "/onboarding?role=venue",
      ),
    ).toBe(true);
    expect(
      isNavLinkActive(
        "/onboarding",
        search("role=performer"),
        "/onboarding?role=venue",
      ),
    ).toBe(false);
  });
});
