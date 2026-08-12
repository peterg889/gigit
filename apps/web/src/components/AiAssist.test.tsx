import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.stubGlobal("React", React);

afterAll(() => {
  vi.unstubAllGlobals();
});

import {
  GearExtractWidget,
  ProfileIngestWidget,
  SlotParseWidget,
} from "./AiAssist";

describe("AI-assist control labels", () => {
  it("associates every free-form source control with a readable label", () => {
    const html = renderToStaticMarkup(
      <>
        <ProfileIngestWidget />
        <SlotParseWidget timeZone="America/Chicago" />
        <GearExtractWidget venueId="ven_test" />
      </>,
    );

    expect(html).toMatch(
      /<label for="([^"]+)">Profile or media link<\/label><input id="\1"/,
    );
    expect(html).toMatch(
      /<label for="([^"]+)">Date, time, format, and pay<\/label><textarea id="\1"/,
    );
    expect(html).toMatch(
      /<label for="([^"]+)">Describe your PA and gear \(optional\)<\/label><textarea id="\1"/,
    );
    expect(html).toMatch(
      /<label for="([^"]+)">Add a gear photo \(optional\)<\/label><input id="\1" type="file"/,
    );
  });
});

describe("AI-assist failure announcements", () => {
  // The region has to be in the markup BEFORE the request fails: a live region
  // that only appears together with its text is not reliably announced, so a
  // screen-reader user pressed the draft button and heard nothing at all.
  it.each([
    ["ProfileIngestWidget", <ProfileIngestWidget key="profile" />],
    ["SlotParseWidget", <SlotParseWidget key="slot" timeZone="America/Chicago" />],
    ["GearExtractWidget", <GearExtractWidget key="gear" venueId="ven_test" />],
  ])("%s mounts its error region before anything fails", (_name, element) => {
    const html = renderToStaticMarkup(element);

    expect(html).toContain('<div aria-live="polite" role="status">');
  });
});
