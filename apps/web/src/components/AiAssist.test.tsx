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
