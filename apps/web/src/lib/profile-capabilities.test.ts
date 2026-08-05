import { describe, expect, it } from "vitest";
import {
  accountCanAct,
  liveProfileForActiveAccount,
} from "./profile-capabilities";

describe("account action capability", () => {
  it("allows lifecycle actions only for an active account", () => {
    expect(accountCanAct("active")).toBe(true);
    expect(accountCanAct("suspended")).toBe(false);
    expect(accountCanAct("deleted")).toBe(false);
    expect(accountCanAct(null)).toBe(false);
  });
});

describe("live marketplace profile capability", () => {
  const live = { id: "profile_live", status: "live" };

  it("returns the live profile only for an active account", () => {
    expect(liveProfileForActiveAccount("active", live)).toBe(live);
    expect(liveProfileForActiveAccount("suspended", live)).toBeNull();
    expect(liveProfileForActiveAccount("deleted", live)).toBeNull();
    expect(liveProfileForActiveAccount(null, live)).toBeNull();
  });

  it("never turns a historical profile into an action capability", () => {
    expect(
      liveProfileForActiveAccount("active", {
        id: "profile_suspended",
        status: "suspended",
      }),
    ).toBeNull();
    expect(
      liveProfileForActiveAccount("active", {
        id: "profile_hidden",
        status: "hidden",
      }),
    ).toBeNull();
    expect(liveProfileForActiveAccount("active", null)).toBeNull();
  });
});
