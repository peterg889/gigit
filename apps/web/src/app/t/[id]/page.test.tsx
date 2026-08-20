import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeTech,
  makeVenue,
  schema,
  setProfileVisibility,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import TechPage from "./page";
// The only writer of a sound-gig review row. Hand-inserting one would pick its
// own author_role, which is the single field the double-blind rule turns on.
import { POST as submitSoundReviewPost } from "../../api/tech-subslots/[id]/review/route";

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

/**
 * What the real `notFound()` throws — `next/navigation` is deliberately NOT
 * mocked here, so a page that stopped calling it cannot pass by throwing
 * something else, and the assertion is against Next's own control flow.
 */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

const renderTech = async (id: string) =>
  renderToStaticMarkup(await TechPage({ params: Promise.resolve({ id }) }));

/**
 * The tech page carried the same storage-key rendering as the other two: an
 * <img> off a signed URL and an <audio controls> pointed at our bucket. Both
 * are gone — a tech's rig photo and their mix are links on hosts we don't run.
 */
describe("a sound tech's media, rendered from links", () => {
  /**
   * `status` is required, deliberately. It used to default to "ready", so no
   * test here ever rendered a tech page holding an unscreened asset — and
   * `eq(schema.mediaAssets.status, "ready")` could be deleted from page.tsx with
   * a green suite.
   */
  const addMedia = (row: {
    subjectId: string;
    ownerUserId: string;
    kind: string;
    status: "held" | "ready" | "blocked";
    embedUrl: string;
    embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
  }) =>
    db()
      .insert(schema.mediaAssets)
      .values({
        id: newId("media"),
        subjectType: "tech",
        ...row,
      });

  const render = async (id: string) =>
    renderToStaticMarkup(await TechPage({ params: Promise.resolve({ id }) }));

  it("shows a rig photo from the host that serves it and links a mix out", async () => {
    const tech = await makeTech({ name: "Linked Tech" });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "photo",
      status: "ready",
      embedUrl: "https://www.flickr.com/photos/tech/47000000001/",
      embedMeta: {
        provider: "flickr",
        title: "Rig at the Cooperage",
        imageUrl: "https://live.staticflickr.com/65535/47000000001_b.jpg",
      },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/linked-tech/board-mix",
      embedMeta: { provider: "soundcloud", title: "Board mix, four-piece" },
    });

    const html = await render(tech.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/47000000001_b.jpg"',
    );
    expect(html).toContain('href="https://soundcloud.com/linked-tech/board-mix"');
    expect(html).toContain("Board mix, four-piece");
    expect(html).not.toContain("<audio");
  });

  /**
   * The tech page publishes the same link-only media as the other two profiles
   * and screens it the same way: `held` until the AI screen clears it, `blocked`
   * once ops upholds a flag (PRD F7.5). Neither state meant anything to any test
   * before this one — every fixture in the file was born "ready", so deleting
   * `eq(schema.mediaAssets.status, "ready")` from page.tsx published a tech's
   * unscreened rig photo and a blocked mix and broke no test.
   *
   * The screened mix is on the same tech so the media card is certainly
   * rendering; and neither unscreened row carries an imageUrl, so the page would
   * print both their URL and their title as an <a> if the gate were gone — which
   * is what makes both halves of each assertion able to fail.
   */
  it("publishes only the screened asset, never the held or the blocked one", async () => {
    const tech = await makeTech({ name: "Screened Tech" });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/screened-tech/cleared-mix",
      embedMeta: { provider: "soundcloud", title: "Cleared board mix" },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "video",
      status: "held",
      embedUrl: "https://www.youtube.com/watch?v=unscreenedrig",
      embedMeta: { provider: "youtube", title: "Unscreened rig walkthrough" },
    });
    await addMedia({
      subjectId: tech.id,
      ownerUserId: tech.ownerUserId,
      kind: "photo",
      status: "blocked",
      embedUrl: "https://imgur.com/gallery/blockedrig",
      embedMeta: { provider: "imgur", title: "Blocked rig photo" },
    });

    const html = await render(tech.id);

    expect(html).toContain('href="https://soundcloud.com/screened-tech/cleared-mix"');
    expect(html).toContain("Cleared board mix");
    expect(html).not.toContain("unscreenedrig");
    expect(html).not.toContain("Unscreened rig walkthrough");
    expect(html).not.toContain("blockedrig");
    expect(html).not.toContain("Blocked rig photo");
  });
});

/**
 * Double-blind on the sound side (PRD F7.1), applied. The tech page runs the
 * SAME shared rule as the act and venue pages, but keyed on the sub-slot's own
 * author roles — `payer` and `tech` — and it asks for `"payer"`, because the
 * only reviews that belong on a tech's public page are the ones written ABOUT
 * them by whoever hired them.
 *
 * Two failures ship green without this. Dropping the `visibleReviews` call
 * publishes a review the day it is written, before the other side has committed
 * to theirs. And flipping that `"payer"` to `"tech"` republishes the tech's own
 * verdicts ON THEIR CUSTOMERS as if they were the tech's reputation — under a
 * heading that says "Reviews from sound bookings", with the tech's own score in
 * the star badge.
 *
 * Both reviews go in through the real POST route: it is the only thing that
 * decides `author_role`.
 */
describe("a sound tech's reviews: the payer's, sealed until both have written", () => {
  /** A finished sound gig — the only state the sound-review route opens on. */
  const releasedSubslot = async (venueId: string, performerId: string, techId: string) => {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    const startsAt = new Date(Date.now() - 3 * 86_400_000);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "tech-blind-metro",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "released",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 7_200_000).toISOString(),
      },
      offerExpiresAt: startsAt,
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 15_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      techId,
      state: "released",
    });
    return subslotId;
  };

  const submitReview = async (
    subslotId: string,
    authorUserId: string,
    ratings: Record<string, number>,
    body: string,
  ) => {
    sessionUserId.mockResolvedValue(authorUserId);
    const res = await submitSoundReviewPost(
      new Request(`http://test/api/tech-subslots/${subslotId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ratings, body }),
      }),
      { params: Promise.resolve({ id: subslotId }) },
    );
    expect(res.status).toBe(201);
    sessionUserId.mockResolvedValue(null);
  };

  it("shows neither side's words while only the tech has written", async () => {
    const venue = await makeVenue({ name: "Sound Blind Room", metro: "tech-blind-metro" });
    const act = await makePerformer({ name: "Sound Blind Act" });
    const tech = await makeTech({ name: "Sealed Review Tech" });
    const subslotId = await releasedSubslot(venue.id, act.id, tech.id);

    await submitReview(
      subslotId,
      tech.ownerUserId,
      { overall: 5 },
      "Room paid late but the gig was fine.",
    );
    // One day old: inside the 7-day window, so nothing but the payer's
    // counterpart could open it — and the payer hasn't written one.
    await db()
      .update(schema.techSubslotReviews)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.techSubslotReviews.subslotId, subslotId));

    const sealed = await renderTech(tech.id);

    expect(sealed).toContain("Sealed Review Tech");
    expect(sealed).not.toContain("Room paid late but the gig was fine.");
    expect(sealed).not.toContain("Reviews from sound bookings");
    // No star badge AT ALL, not "★ 0.0 (0)": averageOverall returns null on an
    // empty set so a tech with nothing visible doesn't wear a rating that reads
    // as "everyone who hired them hated it".
    expect(sealed).not.toContain("★");

    // The room answers, on the same sub-slot. A different score on purpose: a
    // page that published the tech's own review instead would read "★ 5.0 (1)"
    // — or "★ 4.5 (2)" if it published both — so the assertion below can only
    // pass on the payer's review alone.
    await submitReview(
      subslotId,
      venue.ownerUserId,
      { overall: 4 },
      "Mixed our four-piece cleanly, showed up early.",
    );

    const opened = await renderTech(tech.id);

    expect(opened).toContain("Reviews from sound bookings");
    expect(opened).toContain("Mixed our four-piece cleanly, showed up early.");
    expect(opened).toContain("★ 4.0 (1)");
    // The tech's verdict on the ROOM is theirs to keep. It is not their
    // reputation and it must never appear on their own public page — in this
    // state or the sealed one above.
    expect(opened).not.toContain("Room paid late but the gig was fine.");
  });
});

/**
 * The documented, shipped regression: this page was a copy-paste that predated
 * the status gate, so `setProfileVisibility` wrote `techs.status` and nothing
 * ever read it — a suspended tech's name, rates and photos stayed up. The
 * column-flip is covered in `packages/db/src/visibility.test.ts` and the unfurl
 * gate in `profile-metadata.test.ts`; the BODY was covered nowhere, which is how
 * it shipped in the first place.
 *
 * Each case renders the tech live first, so the 404 that follows is the status
 * gate and not a fixture that never rendered.
 */
describe("a sound tech's page stops being served once the profile is not live", () => {
  it("404s after the owner deactivates the account", async () => {
    const tech = await makeTech({ name: "Deactivated Tech" });
    expect(await renderTech(tech.id)).toContain("Deactivated Tech");

    await setProfileVisibility(tech.ownerUserId, "hidden");

    await expect(renderTech(tech.id)).rejects.toThrow(NOT_FOUND);
  });

  it("404s while ops has the account suspended", async () => {
    const tech = await makeTech({ name: "Suspended Tech" });
    expect(await renderTech(tech.id)).toContain("Suspended Tech");

    await setProfileVisibility(tech.ownerUserId, "suspended");

    await expect(renderTech(tech.id)).rejects.toThrow(NOT_FOUND);
  });
});
