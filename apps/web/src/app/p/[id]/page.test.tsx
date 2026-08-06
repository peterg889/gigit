import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, makePerformer } from "@gigit/db";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import PerformerPage from "./page";

/**
 * `/p/[id]` is the one page that travels on its own: the act sends the link to a
 * booker, the booker pastes it into a group chat. A profile with nothing in it
 * used to greet that booker with two statements of absence — "has not added a
 * bio yet" and "has not added photos, audio, video, or reviews yet" — at the
 * exact moment someone was deciding whether to take a chance on the act. The
 * only person who can fix either is the owner, so they're the only one told.
 */
describe("an act's shareable profile, before they've filled it in", () => {
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  const render = async (id: string) =>
    renderToStaticMarkup(await PerformerPage({ params: Promise.resolve({ id }) }));

  it("says nothing to a booker about what the act is missing", async () => {
    const act = await makePerformer({ name: "Bare Profile Act", bio: "" });
    sessionUserId.mockResolvedValue(null);

    const html = await render(act.id);

    expect(html).toContain("Bare Profile Act");
    expect(html).not.toMatch(/has not added/i);
    expect(html).not.toMatch(/no bio yet/i);
    // and it does not push the booker into the owner's editing flow
    expect(html).not.toContain('href="/me"');
  });

  it("asks the owner for the photo and the bio, and says why", async () => {
    const act = await makePerformer({ name: "Own Profile Act", bio: "" });
    sessionUserId.mockResolvedValue(act.ownerUserId);

    const html = await render(act.id);

    expect(html).toMatch(/no bio yet/i);
    expect(html).toMatch(/Add photos, audio, or video/i);
    expect(html).toContain('href="/me"');
  });

  it("shows a filled-in bio to everyone and drops the prompt", async () => {
    const act = await makePerformer({
      name: "Filled Profile Act",
      bio: "Four-piece out of Bay View, loud and on time.",
    });
    sessionUserId.mockResolvedValue(act.ownerUserId);

    const html = await render(act.id);

    expect(html).toContain("Four-piece out of Bay View");
    expect(html).not.toMatch(/no bio yet/i);
  });
});
