import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeTech,
  makeUser,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import TechsPage from "./page";

describe("sound job marketplace eligibility", () => {
  const subslotIds: string[] = [];
  const bookingIds: string[] = [];
  const slotIds: string[] = [];
  const venueIds: string[] = [];
  const performerIds: string[] = [];
  const techIds: string[] = [];
  const userIds: string[] = [];

  const directoryLiveTechId = newId("tech");
  const directoryHiddenTechId = newId("tech");
  const directoryInactiveOwnerTechId = newId("tech");

  /**
   * The directory query takes the 100 OLDEST live techs, and the development
   * database already holds ~2,000 of them — so a fixture created now sorts off
   * the end of the page and every absence assertion below would pass because
   * nothing rendered at all. Dating these before the oldest real row (2022-01)
   * puts all three inside the cap, so a row is missing only when the WHERE
   * clause excluded it.
   */
  const DIRECTORY_EPOCH = new Date("2021-01-01T00:00:00.000Z");

  async function seedDirectoryTech(
    id: string,
    name: string,
    options: {
      status?: string;
      ownerStatus?: string;
      gear?: string;
      bio?: string;
      rateLaborCents?: number;
      rateWithRigCents?: number;
      travelRadiusMiles?: number;
    } = {},
  ) {
    const ownerUserId = await makeUser();
    userIds.push(ownerUserId);
    techIds.push(id);
    if (options.ownerStatus)
      await db()
        .update(schema.users)
        .set({ status: options.ownerStatus })
        .where(eq(schema.users.id, ownerUserId));
    await db().insert(schema.techs).values({
      id,
      ownerUserId,
      name,
      bio: options.bio ?? "",
      gear: options.gear ?? "full_rig",
      rateLaborCents: options.rateLaborCents ?? null,
      rateWithRigCents: options.rateWithRigCents ?? null,
      travelRadiusMiles: options.travelRadiusMiles ?? 30,
      status: options.status ?? "live",
      createdAt: DIRECTORY_EPOCH,
    });
  }

  async function seedJob(
    label: string,
    options: {
      bookingState?: string;
      startsAt?: Date;
      venueStatus?: string;
      performerOwnerStatus?: string;
      subslotState?: string;
    } = {},
  ) {
    const venue = await makeVenue({
      name: `${label} VENUE`,
      ...(options.venueStatus ? { status: options.venueStatus } : {}),
    });
    const performer = await makePerformer({ name: `${label} ACT` });
    venueIds.push(venue.id);
    performerIds.push(performer.id);
    userIds.push(venue.ownerUserId, performer.ownerUserId);
    if (options.performerOwnerStatus)
      await db()
        .update(schema.users)
        .set({ status: options.performerOwnerStatus })
        .where(inArray(schema.users.id, [performer.ownerUserId]));

    const startsAt =
      options.startsAt ?? new Date(Date.now() + 14 * 86_400_000);
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    slotIds.push(slotId);
    bookingIds.push(bookingId);
    subslotIds.push(subslotId);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "sound-marketplace-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      venueId: venue.id,
      performerId: performer.id,
      state: options.bookingState ?? "confirmed",
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: startsAt,
      agreementTemplateVer: "v1",
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 12_345,
      needs: {
        verdict: "tech_needed",
        gaps: [],
        inputs: 4,
        notes: label,
      },
      state: options.subslotState ?? "open",
    });
  }

  beforeAll(async () => {
    await seedJob("ELIGIBLE SOUND JOB", {
      // The marketplace caps results, so this fixture is deliberately the next
      // actionable gig rather than relying on global created_at ordering.
      startsAt: new Date(Date.now() + 5 * 60_000),
    });
    await seedJob("CANCELLED SOUND JOB", {
      bookingState: "cancelled_by_venue",
    });
    await seedJob("PAST SOUND JOB", {
      startsAt: new Date(Date.now() - 60_000),
    });
    await seedJob("HIDDEN VENUE SOUND JOB", { venueStatus: "hidden" });
    await seedJob("SUSPENDED OWNER SOUND JOB", {
      performerOwnerStatus: "suspended",
    });
    // Proposed by one party and billed to the other, with no answer yet. The
    // board is where a tech decides to spend a night, so a job whose payer has
    // not agreed to fund it must not be on it.
    // Minutes out, like the eligible control: the board caps at 50 rows
    // ordered by downbeat, and a fixture two weeks away in a long-lived dev
    // database never reaches the page at all — the absence assertion would
    // then pass without the state filter doing any work.
    await seedJob("UNCONSENTED SOUND JOB", {
      subslotState: "awaiting_payer",
      startsAt: new Date(Date.now() + 6 * 60_000),
    });
    await seedDirectoryTech(directoryLiveTechId, "DIRECTORY LIVE TECH", {
      gear: "partial",
      bio: "DIRECTORY LIVE BIO",
      rateLaborCents: 12_500,
      rateWithRigCents: 30_000,
      travelRadiusMiles: 42,
    });
    await seedDirectoryTech(directoryHiddenTechId, "DIRECTORY HIDDEN TECH", {
      status: "hidden",
    });
    await seedDirectoryTech(
      directoryInactiveOwnerTechId,
      "DIRECTORY INACTIVE OWNER TECH",
      { ownerStatus: "suspended" },
    );
  });

  afterAll(async () => {
    const d = db();
    await d
      .delete(schema.techSubslots)
      .where(inArray(schema.techSubslots.id, subslotIds));
    await d
      .delete(schema.bookings)
      .where(inArray(schema.bookings.id, bookingIds));
    await d.delete(schema.slots).where(inArray(schema.slots.id, slotIds));
    await d
      .delete(schema.performers)
      .where(inArray(schema.performers.id, performerIds));
    await d.delete(schema.techs).where(inArray(schema.techs.id, techIds));
    await d.delete(schema.venues).where(inArray(schema.venues.id, venueIds));
    await d.delete(schema.users).where(inArray(schema.users.id, userIds));
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("lists only future open sound work attached to a confirmed, active gig", async () => {
    sessionUserId.mockResolvedValue(null);
    const html = renderToStaticMarkup(await TechsPage());

    expect(html).toContain("ELIGIBLE SOUND JOB");
    expect(html).toContain(
      '<article class="card"><strong>ELIGIBLE SOUND JOB ACT</strong>',
    );
    expect(html).not.toContain("CANCELLED SOUND JOB");
    expect(html).not.toContain("PAST SOUND JOB");
    expect(html).not.toContain("HIDDEN VENUE SOUND JOB");
    expect(html).not.toContain("SUSPENDED OWNER SOUND JOB");
    expect(html).not.toContain("UNCONSENTED SOUND JOB");
  });

  /**
   * The half of this page a venue or act actually came for. Everything above
   * asserts the sound-JOB panel, so the entire `techs.map(...)` block could be
   * deleted without turning this file red — a directory that renders nobody is
   * the failure mode a cold market cannot afford to ship silently.
   */
  it("renders a live tech's name, gear, rates and travel range, and no one else's", async () => {
    sessionUserId.mockResolvedValue(null);
    const html = renderToStaticMarkup(await TechsPage());

    const cardStart = html.indexOf(`href="/t/${directoryLiveTechId}"`);
    expect(cardStart).toBeGreaterThan(-1);
    // Scope every fact to this tech's own card: the 100 real rows beside it
    // carry the same gear labels and travel distances, so a page-wide
    // `toContain` would be satisfied by somebody else's profile.
    const card = html.slice(cardStart, html.indexOf("</div>", cardStart));
    expect(card).toContain("DIRECTORY LIVE TECH");
    expect(card).toContain("Partial rig");
    expect(card).toContain("DIRECTORY LIVE BIO");
    expect(card).toContain("Travels 42 miles");
    // Both rates, each against its own label — the two columns are adjacent,
    // same-typed and swappable, and a bare "$125" cannot tell them apart.
    expect(card).toMatch(/Labor:\s*<span class="money">\$125<\/span>/);
    expect(card).toMatch(/With rig:\s*<span class="money">\$300<\/span>/);

    // Both exclusions are dated into the cap alongside the row above, so these
    // fail the moment either half of the directory's WHERE clause is dropped.
    expect(html).not.toContain("DIRECTORY HIDDEN TECH");
    expect(html).not.toContain("DIRECTORY INACTIVE OWNER TECH");
  });

  /**
   * /techs is the only tech-labelled destination in the global nav, and
   * onboarding now lands a newly-created tech here rather than on /bookings,
   * which they cannot have anything on. So it can't open by explaining how to
   * hire an engineer — to a tech, that's a page about somebody else.
   */
  describe("who the page is addressed to", () => {
    it("reads as a directory to a venue or act shopping for sound", async () => {
      sessionUserId.mockResolvedValue(null);
      const html = renderToStaticMarkup(await TechsPage());
      expect(html).toMatch(/Find local live engineers/i);
      expect(html).not.toMatch(/the roster you&#x27;re on/i);
    });

    it("reads as their own board to someone who runs sound", async () => {
      const tech = await makeTech({ name: "ADDRESSED TECH" });
      userIds.push(tech.ownerUserId);
      techIds.push(tech.id);
      sessionUserId.mockResolvedValue(tech.ownerUserId);

      const html = renderToStaticMarkup(await TechsPage());
      expect(html).toMatch(/the roster you&#x27;re on/i);
      expect(html).not.toMatch(/Find local live engineers/i);
    });
  });
});
