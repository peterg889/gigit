import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, schema } from "@gigit/db";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import BookingsPage from "./page";

describe("bookings dashboard outcome copy", () => {
  const userId = newId("user");
  const venueOwnerId = newId("user");
  const otherPerformerOwnerId = newId("user");
  const performerId = newId("performer");
  const otherPerformerId = newId("performer");
  const venueId = newId("venue");
  const techId = newId("tech");

  async function seedSoundApplication(input: {
    applicationStatus: string;
    subslotState: string;
    bookingState: string;
    dayOffset: number;
  }) {
    const startsAt = new Date(Date.now() + input.dayOffset * 86_400_000);
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const subslotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "dashboard-copy",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: input.bookingState === "confirmed" ? "filled" : "cancelled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId: otherPerformerId,
      venueId,
      state: input.bookingState,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    await db().insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state: input.subslotState,
      ...(input.applicationStatus === "booked" ? { techId } : {}),
    });
    await db().insert(schema.techSubslotApplications).values({
      id: newId("application"),
      subslotId,
      techId,
      status: input.applicationStatus,
    });
  }

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: userId, email: `${userId}@dashboard-copy.test` },
      { id: venueOwnerId, email: `${venueOwnerId}@dashboard-copy.test` },
      {
        id: otherPerformerOwnerId,
        email: `${otherPerformerOwnerId}@dashboard-copy.test`,
      },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Dashboard Copy Room",
      metro: "dashboard-copy",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values([
      {
        id: performerId,
        ownerUserId: userId,
        kind: "band",
        name: "Dashboard Copy Applicant",
        homeMetro: "dashboard-copy",
      },
      {
        id: otherPerformerId,
        ownerUserId: otherPerformerOwnerId,
        kind: "band",
        name: "Dashboard Sound Act",
        homeMetro: "dashboard-copy",
      },
    ]);
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: userId,
      name: "Dashboard Copy Tech",
      gear: "full_rig",
    });

    const applicationStartsAt = new Date(Date.now() + 20 * 86_400_000);
    const applicationSlotId = newId("slot");
    await d.insert(schema.slots).values({
      id: applicationSlotId,
      venueId,
      metro: "dashboard-copy",
      startsAt: applicationStartsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 20_000,
      status: "open",
    });
    await d.insert(schema.applications).values({
      id: newId("application"),
      slotId: applicationSlotId,
      performerId,
      status: "declined",
      declineReason: "venue_declined",
    });

    await seedSoundApplication({
      applicationStatus: "withdrawn",
      subslotState: "open",
      bookingState: "confirmed",
      dayOffset: 21,
    });
    await seedSoundApplication({
      applicationStatus: "declined",
      subslotState: "cancelled_with_parent",
      bookingState: "cancelled_by_venue",
      dayOffset: 22,
    });
    await seedSoundApplication({
      applicationStatus: "booked",
      subslotState: "booked",
      bookingState: "confirmed",
      dayOffset: -1,
    });
    sessionUserId.mockResolvedValue(userId);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  it("uses persisted decline reasons and each sound application outcome", async () => {
    const markup = renderToStaticMarkup(await BookingsPage());
    expect(markup).toContain("decided not to move forward");
    expect(markup).not.toContain("This one went to another act");
    expect(markup).toContain("You withdrew this application.");
    expect(markup).toContain("This sound job closed before you were booked.");
    expect(markup).toContain(
      "You are still the booked tech for this confirmed gig.",
    );
    expect(markup).not.toContain(
      "The parent booking is no longer active, so this sound assignment is closing.",
    );
    expect(markup).not.toContain("This sound job was filled by another tech.");
  });
});
