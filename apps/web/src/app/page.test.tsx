import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

type CapabilityProfile = { status: string };
type Capabilities = {
  accountStatus: string;
  owned: {
    performer: CapabilityProfile | null;
    venue: CapabilityProfile | null;
    tech: CapabilityProfile | null;
  };
  live: {
    performer: CapabilityProfile | null;
    venue: CapabilityProfile | null;
    tech: CapabilityProfile | null;
  };
};

const controls = vi.hoisted(() => ({
  userId: null as string | null,
  capabilities: null as Capabilities | null,
}));

vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(controls.userId),
}));
vi.mock("@/lib/auth", () => ({
  profileCapabilitiesOwnedBy: () => Promise.resolve(controls.capabilities),
}));

import HomePage from "./page";

const emptyProfiles = {
  performer: null,
  venue: null,
  tech: null,
};

async function renderHome() {
  return renderToStaticMarkup(await HomePage());
}

describe("home capability-aware calls to action", () => {
  beforeEach(() => {
    controls.userId = "usr_home";
    controls.capabilities = {
      accountStatus: "active",
      owned: { ...emptyProfiles },
      live: { ...emptyProfiles },
    };
  });

  it("sends an inactive account to account review instead of onboarding", async () => {
    controls.capabilities = {
      accountStatus: "suspended",
      owned: { ...emptyProfiles, performer: { status: "hidden" } },
      live: { ...emptyProfiles },
    };

    const html = await renderHome();
    expect(html).toMatch(/href="\/account"[^>]*>Review account<\/a>/);
    expect(html).not.toContain(">Get started</a>");
    expect(html).toContain("marketplace actions are unavailable");
  });

  it("sends an active historical-profile owner to profiles", async () => {
    controls.capabilities!.owned.performer = { status: "hidden" };

    const html = await renderHome();
    expect(html).toMatch(/href="\/me"[^>]*>Your profiles<\/a>/);
    expect(html).toContain("Review profiles");
    expect(html).not.toContain(">Get started</a>");
  });

  it("offers onboarding to an active account with no profile history", async () => {
    const html = await renderHome();
    expect(html).toMatch(/href="\/onboarding"[^>]*>Get started<\/a>/);
    expect(html).toContain("Tell us what you do");
  });
});
