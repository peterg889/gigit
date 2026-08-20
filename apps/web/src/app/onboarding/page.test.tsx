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

async function renderOnboarding(
  role?: string,
  extra: { welcome?: string } = {},
) {
  return renderToStaticMarkup(
    await OnboardingPage({ searchParams: Promise.resolve({ role, ...extra }) }),
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

  /**
   * The signup redirect sets `welcome=1`, so this is the one screen an act sees
   * with nothing else competing for attention — and it used to spend it pointing
   * at a gig feed that, on a young marketplace, is usually empty. An act who
   * just submitted the form has no media by construction.
   */
  it("asks a brand-new act for a photo and a track, as links", async () => {
    const act = { name: "Fresh Act", status: "live", foundingMember: false };
    controls.capabilities.owned.performer = act;
    controls.capabilities.live.performer = act;

    const html = await renderOnboarding("performer", { welcome: "1" });
    expect(html).toMatch(/Link a photo, a track, or a video/i);
    // EightGig hosts no user media, so the one screen that asks for it must not
    // promise an uploader. "Add photos, audio, or video" sent a new act looking
    // for a file picker that no longer exists on /me.
    expect(html).toMatch(/paste the link/i);
    expect(html).not.toMatch(/upload/i);
  });

  it("does not nag an act who came back to the page later", async () => {
    const act = { name: "Returning Act", status: "live", foundingMember: false };
    controls.capabilities.owned.performer = act;
    controls.capabilities.live.performer = act;

    const html = await renderOnboarding("performer");
    expect(html).not.toMatch(/Link a photo, a track, or a video/i);
  });

  /**
   * The RETURNING branch, which is the only one a tech ever reaches here: unlike
   * the act and venue forms, `/api/techs` redirects to `/techs` rather than back
   * with `welcome=1`, so this page only ever sees a tech who navigated to it
   * again. (This test used to pass `welcome=1` — a state the tech creation path
   * cannot produce, which made it a test of a screen nobody sees.)
   *
   * A sound tech has no bookings and cannot have any until somebody else's
   * booking is confirmed and a party posts sound work, so the one call to
   * action has to be the job board, not an empty booking list.
   */
  it("sends a returning sound tech to the board they can actually act on", async () => {
    const tech = { name: "Returning Tech", status: "live" };
    controls.capabilities.owned.tech = tech;
    controls.capabilities.live.tech = tech;

    const html = await renderOnboarding("tech");
    // Pin the returning branch itself: the welcome copy is what the redirect
    // never produces, so seeing it here would mean the test drifted back.
    expect(html).toContain("You’re set up");
    expect(html).not.toContain("You’re in");
    expect(html).toContain("Your sound tech profile is ready.");
    expect(html).toContain('href="/techs"');
    expect(html).toContain("View sound work");
    expect(html).not.toContain('href="/bookings"');
  });
});
