import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { inArray } from "drizzle-orm";

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
  const userIds: string[] = [];

  async function seedJob(
    label: string,
    options: {
      bookingState?: string;
      startsAt?: Date;
      venueStatus?: string;
      performerOwnerStatus?: string;
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
      state: "open",
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
  });
});
