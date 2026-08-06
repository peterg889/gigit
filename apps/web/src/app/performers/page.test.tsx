import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, makePerformer, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import PerformerSearchPage from "./page";

describe("performer invite dates", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let performer: Awaited<ReturnType<typeof makePerformer>>;
  const freeSlotId = newId("slot");
  const offeredSlotId = newId("slot");
  const confirmingSlotId = newId("slot");
  const offeredBookingId = newId("booking");
  const confirmingBookingId = newId("booking");

  beforeAll(async () => {
    venue = await makeVenue({ name: "Invite Hold Room" });
    performer = await makePerformer({
      name: "Invite Hold Act",
      homeMetro: "held-invite-test",
    });
    const startsAt = new Date(Date.now() + 86_400_000);
    await db().insert(schema.slots).values(
      [freeSlotId, offeredSlotId, confirmingSlotId].map((id, index) => ({
        id,
        venueId: venue.id,
        metro: "held-invite-test",
        startsAt: new Date(startsAt.getTime() + index * 86_400_000),
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000 + index * 1_000,
      })),
    );
    await db().insert(schema.bookings).values([
      {
        id: offeredBookingId,
        slotId: offeredSlotId,
        venueId: venue.id,
        performerId: performer.id,
        state: "offered",
        terms: {
          amountCents: 31_000,
          startsAt: new Date(startsAt.getTime() + 86_400_000).toISOString(),
          endsAt: new Date(startsAt.getTime() + 86_400_000 + 7_200_000).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() + 3_600_000),
      },
      {
        id: confirmingBookingId,
        slotId: confirmingSlotId,
        venueId: venue.id,
        performerId: performer.id,
        state: "confirming",
        terms: {
          amountCents: 32_000,
          startsAt: new Date(startsAt.getTime() + 2 * 86_400_000).toISOString(),
          endsAt: new Date(startsAt.getTime() + 2 * 86_400_000 + 7_200_000).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() + 3_600_000),
      },
    ]);
  });

  afterAll(async () => {
    await db()
      .delete(schema.bookings)
      .where(inArray(schema.bookings.id, [offeredBookingId, confirmingBookingId]));
    await db()
      .delete(schema.slots)
      .where(inArray(schema.slots.id, [freeSlotId, offeredSlotId, confirmingSlotId]));
    await db().delete(schema.performers).where(inArray(schema.performers.id, [performer.id]));
    await db().delete(schema.venues).where(inArray(schema.venues.id, [venue.id]));
    await db()
      .delete(schema.users)
      .where(inArray(schema.users.id, [venue.ownerUserId, performer.ownerUserId]));
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("offers only genuinely free dates in the invite form", async () => {
    sessionUserId.mockResolvedValue(venue.ownerUserId);
    const html = renderToStaticMarkup(
      await PerformerSearchPage({
        searchParams: Promise.resolve({ metro: "held-invite-test" }),
      }),
    );

    expect(html).toContain("Invite Hold Act");
    expect(html).toContain(`value="${freeSlotId}"`);
    expect(html).not.toContain(`value="${offeredSlotId}"`);
    expect(html).not.toContain(`value="${confirmingSlotId}"`);
  });

  /**
   * "Find an act" is one of four discovery links in the global nav, so every act
   * clicks it eventually. The gate is correct — only a venue may invite or
   * message, which is what stops cold DMs — but it used to answer a band with a
   * "Set up your venue" button, which is not a thing a band wants to do.
   */
  it("does not tell an act to go set up a venue", async () => {
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const html = renderToStaticMarkup(
      await PerformerSearchPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).not.toContain("/onboarding?role=venue");
    expect(html).not.toMatch(/Set up your venue/i);
    // Sent somewhere that is actually theirs instead.
    expect(html).toContain('href="/slots"');
    // And still gated: no roster, no invite form.
    expect(html).not.toContain(`value="${freeSlotId}"`);
  });
});
