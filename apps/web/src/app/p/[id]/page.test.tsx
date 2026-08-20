import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeUser,
  makeVenue,
  schema,
  setProfileVisibility,
} from "@gigit/db";
import { eq } from "drizzle-orm";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import PerformerPage from "./page";
// The two real writers of media status, driven here rather than imitated: the
// embed route is the only way a link ever reaches a profile (and the only thing
// that decides it starts `held`), and the flag resolver is the only way ops
// blocks one. Seeding the statuses by hand would prove the fixture agreed with
// the page, not that the rail a moderator actually operates has any effect.
import { POST as addEmbedPost } from "../../api/media/embed/route";
import { POST as resolveFlagPost } from "../../api/admin/flags/[id]/resolve/route";
// The only writer of a review row. Inserting one by hand would pick its own
// author_role, which is the exact field the double-blind rule below turns on.
import { POST as submitReviewPost } from "../../api/bookings/[id]/review/route";

/**
 * What the real `notFound()` throws — `next/navigation` is deliberately NOT
 * mocked here, so a page that stopped calling it cannot pass by throwing
 * something else, and the assertion is against Next's own control flow.
 */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

// File-level, not per-describe: unstubbing React at the end of the first
// describe left every later test in this file rendering with no global React.
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

const render = async (id: string) =>
  renderToStaticMarkup(await PerformerPage({ params: Promise.resolve({ id }) }));

/**
 * `status` is required, deliberately. This helper used to default it to
 * "ready", which meant no test in this file ever rendered a page holding an
 * unscreened asset — and `eq(mediaAssets.status, "ready")` could be deleted from
 * the page with a green suite.
 */
const addMedia = (row: {
  /** Pass one when a later step (an ops flag) has to name the asset. */
  id?: string;
  subjectId: string;
  ownerUserId: string;
  kind: string;
  status: "held" | "ready" | "blocked";
  embedUrl: string;
  embedMeta?: typeof schema.mediaAssets.$inferInsert.embedMeta;
}) =>
  db()
    .insert(schema.mediaAssets)
    .values({ id: newId("media"), subjectType: "performer", ...row });

/**
 * `/p/[id]` is the one page that travels on its own: the act sends the link to a
 * booker, the booker pastes it into a group chat. A profile with nothing in it
 * used to greet that booker with two statements of absence — "has not added a
 * bio yet" and "has not added photos, audio, video, or reviews yet" — at the
 * exact moment someone was deciding whether to take a chance on the act. The
 * only person who can fix either is the owner, so they're the only one told.
 */
describe("an act's shareable profile, before they've filled it in", () => {
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
    // The ask names the action the product actually supports: paste a link.
    // "Add photos, audio, or video" described an uploader that no longer exists.
    expect(html).toMatch(/Link a photo, a track, or a video/i);
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

  /**
   * Acts write their bio in verses and paragraphs — the lineup on one line, the
   * pitch under it. HTML collapses those newlines, so the page a booker pastes
   * into a group chat used to show the whole thing as one unbroken grey block.
   */
  it("keeps the line breaks the act typed into their bio", async () => {
    const act = await makePerformer({
      name: "Formatted Bio Act",
      bio: "Four-piece out of Bay View.\n\nLoud, and on time.",
    });
    sessionUserId.mockResolvedValue(null);

    const html = await render(act.id);

    expect(html).toContain(
      '<p class="user-text">Four-piece out of Bay View.\n\nLoud, and on time.</p>',
    );
  });
});

/**
 * Every asset is now a link on somebody else's server: there is no storage key
 * to sign and no file of ours to stream. What the page renders comes out of
 * embed_url and the metadata the provider volunteered.
 */
describe("an act's media, rendered from links", () => {
  it("shows a photo as an image served by the host that holds it", async () => {
    const act = await makePerformer({ name: "Photo Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "photo",
      status: "ready",
      embedUrl: "https://www.flickr.com/photos/band/51234567890/",
      embedMeta: {
        provider: "flickr",
        title: "At the Cactus Club",
        imageUrl: "https://live.staticflickr.com/65535/51234567890_b.jpg",
      },
    });

    const html = await render(act.id);

    expect(html).toContain(
      '<img src="https://live.staticflickr.com/65535/51234567890_b.jpg"',
    );
    expect(html).toContain('alt="At the Cactus Club"');
  });

  /**
   * A Flickr link whose oEmbed fetch timed out is stored with no imageUrl. It
   * must still reach the booker as a link — an <img> with an empty src would
   * render as a broken picture, and dropping the row hides media the act added.
   */
  it("falls back to a link when the provider gave us no image", async () => {
    const act = await makePerformer({ name: "Unenriched Photo Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "photo",
      status: "ready",
      embedUrl: "https://imgur.com/gallery/abc123",
      embedMeta: { provider: "imgur" },
    });

    const html = await render(act.id);

    expect(html).toContain('href="https://imgur.com/gallery/abc123"');
    expect(html).not.toContain("<img");
  });

  /**
   * Audio used to be an <audio controls src> pointed at our own bucket. A
   * SoundCloud track is not a file we can hand to that element, so it goes out
   * as a badged link to the page that plays it.
   */
  it("sends a listener to the track's own page instead of a dead player", async () => {
    const act = await makePerformer({ name: "Audio Act" });
    sessionUserId.mockResolvedValue(null);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/audio-act/live-at-x",
      embedMeta: { provider: "soundcloud", title: "Live at X" },
    });

    const html = await render(act.id);

    expect(html).toContain("Listen");
    expect(html).toContain('href="https://soundcloud.com/audio-act/live-at-x"');
    expect(html).toContain("Live at X");
    expect(html).toContain("SoundCloud");
    expect(html).not.toContain("<audio");
  });

  it("still shows video, and stops asking the owner for media once there is some", async () => {
    const act = await makePerformer({ name: "Video Act" });
    sessionUserId.mockResolvedValue(act.ownerUserId);
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "video",
      status: "ready",
      embedUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      embedMeta: { provider: "youtube", title: "Whole set, Bay View" },
    });

    const html = await render(act.id);

    expect(html).toContain("Watch");
    expect(html).toContain('href="https://www.youtube.com/watch?v=abcdefghijk"');
    expect(html).toContain("YouTube");
    expect(html).not.toMatch(/Link a photo, a track, or a video/i);
  });
});

/**
 * The moderation gate. `/p/[id]` is the page an act mails to a booker and the
 * booker pastes into a group chat, so an unscreened link on it is a stranger's
 * URL republished under the act's name — which is the entire reason an asset
 * lands `held` and the entire reason ops can push one to `blocked`
 * (technical-design A10: "nothing publishes media before screening").
 *
 * Both writes were already covered — the worker keeps a high-risk asset held,
 * the flag resolver writes blocked — and neither state meant anything, because
 * every media fixture in this file hardcoded "ready". Deleting
 * `eq(schema.mediaAssets.status, "ready")` from page.tsx published every held
 * and blocked link on every act profile and broke no test.
 *
 * Each case puts a screened asset and an unscreened one on the SAME act, so the
 * media card is definitely rendering: absence of the unscreened link is the
 * filter doing its job, not the section being missing.
 */
describe("only screened media reaches an act's public page", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    // Restored by hand rather than through vi.unstubAllGlobals(), which the
    // file-level afterAll owns — it would take the React stub with it and every
    // later render in this file would have no global React.
    globalThis.fetch = realFetch;
  });

  /** Every provider oEmbed lookup in this describe answers from here. */
  const stubOembed = (title: string) => {
    globalThis.fetch = (async () => Response.json({ title })) as typeof fetch;
  };

  it("holds a link the act just pasted until it has been screened", async () => {
    const act = await makePerformer({ name: "Screening Act" });
    // Already screened and public: this is what the booker is meant to see.
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/screening-act/cleared-board-mix",
      embedMeta: { provider: "soundcloud", title: "Cleared board mix" },
    });

    // The real front door: the embed route is the only way media reaches a
    // profile, and it is what decides a fresh link starts held.
    sessionUserId.mockResolvedValue(act.ownerUserId);
    stubOembed("Unscreened demo");
    const res = await addEmbedPost(
      new Request("http://test/api/media/embed", {
        method: "POST",
        body: JSON.stringify({
          url: "https://soundcloud.com/screening-act/unscreened-demo",
          subjectType: "performer",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { id: pastedId } = (await res.json()) as { id: string };
    const [pasted] = await db()
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, pastedId));
    // Pin the producer too: if the route ever started writing "ready", the
    // assertions below would still pass while nothing was being screened.
    expect(pasted?.status).toBe("held");
    expect(pasted?.embedMeta?.title).toBe("Unscreened demo");

    sessionUserId.mockResolvedValue(null);
    const html = await render(act.id);

    expect(html).toContain(
      'href="https://soundcloud.com/screening-act/cleared-board-mix"',
    );
    expect(html).toContain("Cleared board mix");
    // The unscreened link is on the page in neither of the two forms the page
    // can render it in: the href, and the provider's title as the link text.
    expect(html).not.toContain("unscreened-demo");
    expect(html).not.toContain("Unscreened demo");
  });

  it("takes a link off the page the moment ops upholds the flag on it", async () => {
    const act = await makePerformer({ name: "Flagged Media Act" });
    await addMedia({
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "audio",
      status: "ready",
      embedUrl: "https://soundcloud.com/flagged-act/kept-track",
      embedMeta: { provider: "soundcloud", title: "Kept track" },
    });
    const flaggedId = newId("media");
    await addMedia({
      id: flaggedId,
      subjectId: act.id,
      ownerUserId: act.ownerUserId,
      kind: "video",
      status: "ready",
      embedUrl: "https://www.youtube.com/watch?v=rippedset",
      embedMeta: { provider: "youtube", title: "Ripped set video" },
    });

    sessionUserId.mockResolvedValue(null);
    const before = await render(act.id);
    // Before the verdict it is public — so the disappearance below is the
    // uphold, not a link the page never knew how to render.
    expect(before).toContain('href="https://www.youtube.com/watch?v=rippedset"');
    expect(before).toContain("Ripped set video");

    // The real ops queue: a flag on the asset, resolved by a real admin through
    // the route a moderator uses. `blocked` is reachable no other way.
    const flagId = newId("media");
    await db().insert(schema.fraudFlags).values({
      id: flagId,
      kind: "ai_screen",
      subjectType: "media",
      subjectId: flaggedId,
      confidence: 90,
      state: "open",
    });
    const admin = await makeUser();
    await db()
      .insert(schema.actorRoles)
      .values({ id: newId("role"), userId: admin, kind: "admin" });
    sessionUserId.mockResolvedValue(admin);
    const verdict = await resolveFlagPost(
      new Request(`http://test/api/admin/flags/${flagId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "uphold" }),
      }),
      { params: Promise.resolve({ id: flagId }) },
    );
    expect(verdict.status).toBe(200);

    sessionUserId.mockResolvedValue(null);
    const after = await render(act.id);

    expect(after).not.toContain("rippedset");
    expect(after).not.toContain("Ripped set video");
    // The act's other track is untouched: upholding one flag blocks one asset.
    expect(after).toContain('href="https://soundcloud.com/flagged-act/kept-track"');
  });
});

/**
 * Double-blind, applied (PRD F7.1). The pure rule is exhaustively covered in
 * `packages/domain/src/reviews.test.ts` — including the exactly-7-days boundary
 * — but nothing exercised the one line that USES it here, and the e2e submits
 * both reviews before it looks at the page, so it never sees the held state.
 * A regression that passed the wrong role to `visibleReviews`, or dropped the
 * call entirely, published a one-sided review to the whole internet on the day
 * it was written, which is precisely the retaliatory review the mechanism
 * exists to prevent — and it shipped green.
 *
 * Both reviews are written through the real POST route: it is the only thing
 * that decides `author_role`, and author_role is the field the rule turns on.
 */
describe("an act's reviews stay sealed until the act has written theirs", () => {
  /** A finished gig, the only state the review route will open on. */
  const releasedBooking = async (venueId: string, performerId: string) => {
    const slotId = newId("slot");
    const startsAt = new Date(Date.now() - 3 * 86_400_000);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "blind-metro",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    const id = newId("booking");
    await db().insert(schema.bookings).values({
      id,
      slotId,
      performerId,
      venueId,
      state: "released",
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 7_200_000).toISOString(),
      },
      offerExpiresAt: startsAt,
    });
    return id;
  };

  const submitReview = async (
    bookingId: string,
    authorUserId: string,
    ratings: Record<string, number>,
    body: string,
  ) => {
    sessionUserId.mockResolvedValue(authorUserId);
    const res = await submitReviewPost(
      new Request(`http://test/api/bookings/${bookingId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ratings, body }),
      }),
      { params: Promise.resolve({ id: bookingId }) },
    );
    expect(res.status).toBe(201);
    sessionUserId.mockResolvedValue(null);
  };

  it("hides a one-sided venue review, then publishes it once the act answers", async () => {
    const venue = await makeVenue({ name: "Blind Test Room", metro: "blind-metro" });
    const act = await makePerformer({ name: "Sealed Review Act", bio: "On time." });
    const bookingId = await releasedBooking(venue.id, act.id);

    await submitReview(
      bookingId,
      venue.ownerUserId,
      { overall: 5 },
      "Packed the room and loaded out clean.",
    );
    // One day old: inside the 7-day window, so the ONLY thing that could
    // publish it is the act's counterpart review, which hasn't been written.
    await db()
      .update(schema.reviews)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.reviews.bookingId, bookingId));

    const sealed = await render(act.id);

    expect(sealed).toContain("Sealed Review Act");
    expect(sealed).not.toContain("Packed the room and loaded out clean.");
    expect(sealed).not.toContain("Reviews from venues");
    // No star badge AT ALL, not "★ 0.0 (0)": averageOverall returns null on an
    // empty set precisely so a profile with nothing visible doesn't wear a
    // rating that reads as "everyone who worked with them hated it".
    expect(sealed).not.toContain("★");

    // The act answers on the same booking. Deliberately a different score, so a
    // page that stopped filtering by author role would read "★ 4.0 (2)" here
    // and the exact-string assertion below would fail rather than coincide.
    await submitReview(
      bookingId,
      act.ownerUserId,
      { overall: 3 },
      "Sound was rough but they paid on the night.",
    );

    const opened = await render(act.id);

    expect(opened).toContain("Reviews from venues");
    expect(opened).toContain("Packed the room and loaded out clean.");
    expect(opened).toContain("★ 5.0 (1)");
    // The act's own words about the ROOM belong on the venue's page, never on
    // their own — the header count above would be 2 if they leaked in here.
    expect(opened).not.toContain("Sound was rough but they paid on the night.");
  });
});

/**
 * `/p/[id]` publishes an act's EPK to anyone with the link. When the owner
 * deactivates or ops suspends the account, `setProfileVisibility` — the one
 * writer both paths share — flips `performers.status`, and this page is what
 * has to read it back. `packages/db/src/visibility.test.ts` proves the column
 * moves and `profile-metadata.test.ts` proves the unfurl gate fails closed;
 * neither proves the BODY stops being served, so the status check could be
 * deleted from page.tsx with a green suite.
 *
 * Each case renders the profile live first, so the 404 that follows is the
 * status gate and not a fixture that never rendered in the first place.
 */
describe("an act's page stops being served once the profile is not live", () => {
  it("404s after the owner deactivates the account", async () => {
    const act = await makePerformer({ name: "Deactivated Act", bio: "Was here." });
    sessionUserId.mockResolvedValue(null);
    expect(await render(act.id)).toContain("Deactivated Act");

    await setProfileVisibility(act.ownerUserId, "hidden");

    await expect(render(act.id)).rejects.toThrow(NOT_FOUND);
  });

  it("404s while ops has the account suspended", async () => {
    const act = await makePerformer({ name: "Suspended Act", bio: "Was here." });
    sessionUserId.mockResolvedValue(null);
    expect(await render(act.id)).toContain("Suspended Act");

    await setProfileVisibility(act.ownerUserId, "suspended");

    await expect(render(act.id)).rejects.toThrow(NOT_FOUND);
  });
});
