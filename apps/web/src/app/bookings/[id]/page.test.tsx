import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  makePerformer,
  makeUser,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import BookingPage from "./page";

describe("booking detail sound history and actionability", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let performer: Awaited<ReturnType<typeof makePerformer>>;
  let techOwnerId: string;
  const techId = newId("tech");
  const slotId = newId("slot");
  const bookingId = newId("booking");
  const releasedSubslotId = newId("slot");
  const cancelledSubslotId = newId("slot");
  const openSubslotId = newId("slot");
  const applicationId = newId("application");
  const startsAt = new Date(Date.now() + 10 * 86_400_000);

  beforeAll(async () => {
    venue = await makeVenue({
      name: "Complete Sound History Room",
      paInventory: { hasPA: false },
    });
    performer = await makePerformer({
      name: "Complete Sound History Act",
      techNeeds: { inputs: 6 },
    });
    techOwnerId = await makeUser();
    const d = db();
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: techOwnerId,
      name: "History Applicant Tech",
      gear: "full_rig",
    });
    await d.insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "complete-sound-history",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 50_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId: performer.id,
      venueId: venue.id,
      state: "confirmed",
      terms: {
        amountCents: 50_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    await d.insert(schema.techSubslots).values([
      {
        id: releasedSubslotId,
        bookingId,
        payer: "venue",
        budgetCents: 11_100,
        needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 6 },
        state: "released",
      },
      {
        id: cancelledSubslotId,
        bookingId,
        payer: "performer",
        budgetCents: 22_200,
        needs: { verdict: "tech_needed", gaps: ["rig"], inputs: 6 },
        state: "cancelled_with_parent",
      },
      {
        id: openSubslotId,
        bookingId,
        payer: "venue",
        budgetCents: 33_300,
        needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 6 },
        state: "open",
      },
    ]);
    await d.insert(schema.techSubslotApplications).values({
      id: applicationId,
      subslotId: openSubslotId,
      techId,
      note: "I can cover it",
      status: "submitted",
    });
    sessionUserId.mockResolvedValue(venue.ownerUserId);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  async function render() {
    return renderToStaticMarkup(
      await BookingPage({ params: Promise.resolve({ id: bookingId }) }),
    );
  }

  it("does not create a missing conversation while rendering a booking", async () => {
    const rows = () =>
      db()
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(eq(schema.threads.subjectId, bookingId));
    expect(await rows()).toHaveLength(0);
    expect(await render()).not.toContain("Messages about this booking");
    expect(await rows()).toHaveLength(0);
  });

  it("renders every child and removes stale Post, Book, and Cancel controls", async () => {
    const live = await render();
    for (const subslotId of [
      releasedSubslotId,
      cancelledSubslotId,
      openSubslotId,
    ])
      expect(live).toContain(`/sound/${subslotId}`);
    for (const pay of ["$111", "$222", "$333"])
      expect(live).toContain(pay);
    expect(live).toContain("Book this tech");
    expect(live).toContain("Cancel sound job");
    expect(live).not.toContain("Post the sound job");

    await db()
      .update(schema.venues)
      .set({ status: "hidden" })
      .where(eq(schema.venues.id, venue.id));
    const historicalVenue = await render();
    expect(historicalVenue).toContain("Cancel booking");
    expect(historicalVenue).toContain("Cancel sound job");
    expect(historicalVenue).not.toContain("Book this tech");
    await db()
      .update(schema.venues)
      .set({ status: "live" })
      .where(eq(schema.venues.id, venue.id));

    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, venue.ownerUserId));
    const inactiveCaller = await render();
    expect(inactiveCaller).toContain("booking history is read-only");
    expect(inactiveCaller).not.toContain("Cancel booking");
    expect(inactiveCaller).not.toContain("Cancel sound job");
    expect(inactiveCaller).not.toContain("Book this tech");
    expect(inactiveCaller).not.toContain("Book them again");
    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, venue.ownerUserId));
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const nonPayer = await render();
    expect(nonPayer).not.toContain("History Applicant Tech");
    expect(nonPayer).not.toContain("I can cover it");
    expect(nonPayer).not.toContain("Book this tech");
    expect(nonPayer).not.toContain("No techs have applied yet");
    sessionUserId.mockResolvedValue(venue.ownerUserId);

    await db()
      .update(schema.techs)
      .set({ status: "suspended" })
      .where(eq(schema.techs.id, techId));
    const inactiveApplicant = await render();
    expect(inactiveApplicant).not.toContain("Book this tech");
    expect(inactiveApplicant).toContain(
      "This tech is not currently available to book.",
    );
    await db()
      .update(schema.techs)
      .set({ status: "live" })
      .where(eq(schema.techs.id, techId));

    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, performer.ownerUserId));
    const inactiveParty = await render();
    expect(inactiveParty).not.toContain("Book this tech");
    expect(inactiveParty).toContain("Cancel sound job");

    const pastStart = new Date(Date.now() - 60_000);
    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, performer.ownerUserId));
    await db()
      .update(schema.bookings)
      .set({
        terms: {
          amountCents: 50_000,
          startsAt: pastStart.toISOString(),
          endsAt: new Date(
            pastStart.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      })
      .where(eq(schema.bookings.id, bookingId));
    await db()
      .update(schema.techSubslots)
      .set({ state: "booked", techId })
      .where(eq(schema.techSubslots.id, openSubslotId));
    await db()
      .update(schema.techSubslotApplications)
      .set({ status: "booked" })
      .where(eq(schema.techSubslotApplications.id, applicationId));

    const afterDownbeat = await render();
    expect(afterDownbeat).not.toContain("Post the sound job");
    expect(afterDownbeat).not.toContain("Book this tech");
    expect(afterDownbeat).toContain("Cancel sound job");
    expect(afterDownbeat).toContain("date will not reopen");
    expect(afterDownbeat).not.toContain("The date reopens");
    expect(afterDownbeat).not.toContain("Reopens the date");

    await db()
      .update(schema.bookings)
      .set({ state: "cancelled_by_venue" })
      .where(eq(schema.bookings.id, bookingId));
    const closedParent = await render();
    expect(closedParent).not.toContain("Cancel sound job");
    for (const subslotId of [
      releasedSubslotId,
      cancelledSubslotId,
      openSubslotId,
    ])
      expect(closedParent).toContain(`/sound/${subslotId}`);
  });
});
