import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

type Profile = {
  name: string;
  status: string;
  foundingMember?: boolean;
};

const controls = vi.hoisted(() => ({
  userId: "usr_onboarding" as string | null,
  capabilities: {
    accountStatus: "active",
    owned: {
      performer: null as Profile | null,
      venue: null as Profile | null,
      tech: null as Profile | null,
    },
    live: {
      performer: null as Profile | null,
      venue: null as Profile | null,
      tech: null as Profile | null,
    },
  },
}));

vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(controls.userId),
}));
vi.mock("@/lib/auth", () => ({
  profileCapabilitiesOwnedBy: () => Promise.resolve(controls.capabilities),
}));

import OnboardingPage from "./page";

async function renderOnboarding(role?: string) {
  return renderToStaticMarkup(
    await OnboardingPage({ searchParams: Promise.resolve({ role }) }),
  );
}

describe("onboarding account capabilities", () => {
  beforeEach(() => {
    controls.userId = "usr_onboarding";
    controls.capabilities.accountStatus = "active";
    controls.capabilities.owned.performer = null;
    controls.capabilities.owned.venue = null;
    controls.capabilities.owned.tech = null;
    controls.capabilities.live.performer = null;
    controls.capabilities.live.venue = null;
    controls.capabilities.live.tech = null;
  });

  it("shows inactive accounts a read-only route to history and support", async () => {
    controls.capabilities.accountStatus = "suspended";
    controls.capabilities.owned.performer = {
      name: "Historical Act",
      status: "hidden",
    };

    const html = await renderOnboarding("performer");
    expect(html).toContain("Your account is not active");
    expect(html).toContain("View your profiles");
    expect(html).toContain("View your booking history");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Create profile and find gigs");
  });

  it("does not advertise marketplace actions for a historical-only profile", async () => {
    controls.capabilities.owned.performer = {
      name: "Historical Act",
      status: "hidden",
    };

    const html = await renderOnboarding("performer");
    expect(html).toContain("profile is saved but not active");
    expect(html).toContain("Edit profile");
    expect(html).not.toContain("Find a gig");
  });
});
