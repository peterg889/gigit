import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const controls = vi.hoisted(() => ({
  capabilities: {
    accountStatus: "suspended",
    owned: {
      performer: {
        id: "performer_history",
        name: "Historical Act",
        status: "hidden",
        kind: "band",
        foundingMember: false,
        foundingNumber: null,
        bio: "Historical profile",
        genreTags: [],
        rateMinCents: null,
        rateMaxCents: null,
        travelRadiusMiles: 30,
        setLengthsMinutes: [60],
        techNeeds: { inputs: 2, micsNeeded: 1, monitorsNeeded: 1 },
        ownerUserId: "usr_me",
      },
      venue: null,
      tech: null,
    },
    live: {
      performer: null,
      venue: null,
      tech: null,
    },
  },
}));

vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve("usr_me"),
}));
vi.mock("@/lib/auth", () => ({
  profileCapabilitiesOwnedBy: () => Promise.resolve(controls.capabilities),
}));

import MePage from "./page";

describe("profile page account capabilities", () => {
  it("preserves historical profile context while making an inactive account read-only", async () => {
    const html = renderToStaticMarkup(await MePage());

    expect(html).toContain("Your account is not active");
    expect(html).toContain("Historical Act");
    expect(html).toContain("hidden");
    expect(html).toContain("View booking history");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Set up payouts");
    expect(html).not.toContain("Edit profile");
    expect(html).not.toContain("Create act profile");
  });

  it("does not link an active historical profile to a missing public page", async () => {
    controls.capabilities.accountStatus = "active";
    const html = renderToStaticMarkup(await MePage());

    expect(html).toContain("Profile saved but not public (hidden).");
    expect(html).not.toContain('href="/p/performer_history"');
    expect(html).toContain("Edit profile");
  });
});
