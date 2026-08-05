import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, createOffer, db, makePerformer, makeVenue, schema } from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq, inArray } from "drizzle-orm";

vi.stubGlobal("React", React);

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import SlotPage from "./page";

describe("slot detail effective expiry", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let applicant: Awaited<ReturnType<typeof makePerformer>>;
  let visitor: Awaited<ReturnType<typeof makePerformer>>;
  const pastSlotId = newId("slot");
  const pastApplicationId = newId("application");
  const futureSlotId = newId("slot");
  const futureApplicationId = newId("application");

  beforeAll(async () => {
    venue = await makeVenue({ name: "Expiry Render Room" });
    applicant = await makePerformer({ name: "Expiry Applicant" });
    visitor = await makePerformer({ name: "Expiry Visitor" });
    await db().insert(schema.slots).values([
      {
        id: pastSlotId,
        venueId: venue.id,
        metro: "expiry-render",
        startsAt: new Date(Date.now() - 60_000),
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000,
      },
      {
        id: futureSlotId,
        venueId: venue.id,
        metro: "expiry-render",
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        durationMinutes: 120,
        format: "music",
        budgetCents: 32_000,
      },
    ]);
    await db().insert(schema.applications).values([
      {
        id: pastApplicationId,
        slotId: pastSlotId,
        performerId: applicant.id,
      },
      {
        id: futureApplicationId,
        slotId: futureSlotId,
        performerId: applicant.id,
      },
    ]);
  });

  afterAll(async () => {
    await db()
      .delete(schema.applications)
      .where(inArray(schema.applications.slotId, [pastSlotId, futureSlotId]));
    await db()
      .delete(schema.slots)
      .where(inArray(schema.slots.id, [pastSlotId, futureSlotId]));
    await db()
      .delete(schema.performers)
      .where(inArray(schema.performers.id, [applicant.id, visitor.id]));
    await db().delete(schema.venues).where(inArray(schema.venues.id, [venue.id]));
    await db()
      .delete(schema.users)
      .where(
        inArray(schema.users.id, [
          venue.ownerUserId,
          applicant.ownerUserId,
          visitor.ownerUserId,
        ]),
      );
    vi.unstubAllGlobals();
    await closeDb();
  });

  async function renderSlot(slotId: string, userId: string) {
    sessionUserId.mockResolvedValue(userId);
    return renderToStaticMarkup(
      await SlotPage({ params: Promise.resolve({ id: slotId }) }),
    );
  }

  it("hides performer application controls after downbeat but keeps future dates actionable", async () => {
    const past = await renderSlot(pastSlotId, visitor.ownerUserId);
    expect(past).toContain("This date has passed.");
    expect(past).not.toContain("Apply for this gig");

    const future = await renderSlot(futureSlotId, visitor.ownerUserId);
    expect(future).toContain("Apply for this gig");
    expect(future).not.toContain("This date has passed.");
  });

  it("keeps the expiry outcome readable after reconciliation closes the application", async () => {
    await db()
      .update(schema.applications)
      .set({ status: "declined", declineReason: "slot_expired" })
      .where(eq(schema.applications.id, pastApplicationId));
    try {
      const past = await renderSlot(pastSlotId, applicant.ownerUserId);
      expect(past).toContain(
        "This date passed without a booking, so your application was closed.",
      );
      expect(past).toContain("This date has passed.");
      expect(past).not.toContain("Apply for this gig");
    } finally {
      await db()
        .update(schema.applications)
        .set({ status: "submitted", declineReason: null })
        .where(eq(schema.applications.id, pastApplicationId));
    }
  });

  it("hides venue manage, offer, and decline controls after downbeat", async () => {
    const past = await renderSlot(pastSlotId, venue.ownerUserId);
    expect(past).toContain(">Date passed<");
    expect(past).not.toContain("Manage this open date");
    expect(past).not.toContain("Send firm offer");
    expect(past).not.toMatch(/<button[^>]*>Decline<\/button>/);

    const future = await renderSlot(futureSlotId, venue.ownerUserId);
    expect(future).toContain("Manage this open date");
    expect(future).toContain("Send firm offer");
    expect(future).toMatch(/<button[^>]*>Decline<\/button>/);
  });

  it("keeps historical ownership readable but inactive capabilities read-only", async () => {
    await db()
      .update(schema.performers)
      .set({ status: "hidden" })
      .where(eq(schema.performers.id, visitor.id));
    try {
      const performerHtml = await renderSlot(futureSlotId, visitor.ownerUserId);
      expect(performerHtml).toContain("Your act profile must be active to apply.");
      expect(performerHtml).not.toContain("Apply for this gig");
      expect(performerHtml).not.toContain("Create an act profile");
    } finally {
      await db()
        .update(schema.performers)
        .set({ status: "live" })
        .where(eq(schema.performers.id, visitor.id));
    }
    await db()
      .update(schema.performers)
      .set({ status: "hidden" })
      .where(eq(schema.performers.id, applicant.id));
    try {
      const applicationHtml = await renderSlot(futureSlotId, applicant.ownerUserId);
      expect(applicationHtml).toContain("Application sent");
      expect(applicationHtml).toContain("Withdraw application");
      expect(applicationHtml).not.toContain("Apply for this gig");
    } finally {
      await db()
        .update(schema.performers)
        .set({ status: "live" })
        .where(eq(schema.performers.id, applicant.id));
    }


    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, venue.ownerUserId));
    try {
      const venueHtml = await renderSlot(futureSlotId, venue.ownerUserId);
      expect(venueHtml).toContain("Applicants (");
      expect(venueHtml).not.toContain("Manage this open date");
      expect(venueHtml).not.toContain("Send firm offer");
      expect(venueHtml).not.toMatch(/<button[^>]*>Decline<\/button>/);
      expect(venueHtml).not.toContain("Find a tech for the night");
    } finally {
      await db()
        .update(schema.users)
        .set({ status: "active" })
        .where(eq(schema.users.id, venue.ownerUserId));
    }
  });

  it("requires a live target profile for new slot actions", async () => {
    await db()
      .update(schema.venues)
      .set({ status: "suspended" })
      .where(eq(schema.venues.id, venue.id));
    try {
      const inactiveVenue = await renderSlot(futureSlotId, visitor.ownerUserId);
      expect(inactiveVenue).toContain("This gig is not accepting applications");
      expect(inactiveVenue).not.toContain("Apply for this gig");
    } finally {
      await db()
        .update(schema.venues)
        .set({ status: "live" })
        .where(eq(schema.venues.id, venue.id));
    }

    await db()
      .update(schema.applications)
      .set({ status: "submitted", declineReason: null })
      .where(eq(schema.applications.id, futureApplicationId));
    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, applicant.ownerUserId));
    try {
      const inactiveApplicant = await renderSlot(futureSlotId, venue.ownerUserId);
      expect(inactiveApplicant).toContain(
        "This act profile is no longer available for a new offer.",
      );
      expect(inactiveApplicant).not.toContain("Send firm offer");
    } finally {
      await db()
        .update(schema.users)
        .set({ status: "active" })
        .where(eq(schema.users.id, applicant.ownerUserId));
    }
  });
  it("tells a venue-declined performer what actually happened", async () => {
    await db()
      .update(schema.applications)
      .set({ status: "declined", declineReason: "venue_declined" })
      .where(eq(schema.applications.id, futureApplicationId));

    const html = await renderSlot(futureSlotId, applicant.ownerUserId);
    expect(html).toContain(
      "The venue decided not to move forward with your application.",
    );
    expect(html).not.toContain("went to another act");
    expect(html).not.toContain("open again");
  });

  it("freezes listing terms while confirmation runs but keeps applications open", async () => {
    await db()
      .update(schema.applications)
      .set({ status: "submitted", declineReason: null })
      .where(eq(schema.applications.id, futureApplicationId));
    const [slot] = await db()
      .select()
      .from(schema.slots)
      .where(eq(schema.slots.id, futureSlotId));
    const bookingId = await createOffer({
      applicationId: futureApplicationId,
      slotId: futureSlotId,
      performerId: applicant.id,
      venueId: venue.id,
      actor: venue.ownerUserId,
      terms: {
        amountCents: slot!.budgetCents,
        startsAt: slot!.startsAt.toISOString(),
        endsAt: new Date(slot!.startsAt.getTime() + 7_200_000).toISOString(),
      },
    });
    await db()
      .update(schema.bookings)
      .set({ state: "confirming" })
      .where(eq(schema.bookings.id, bookingId));
    try {
      const venueHtml = await renderSlot(futureSlotId, venue.ownerUserId);
      expect(venueHtml).toContain("Date on hold");
      expect(venueHtml).toContain("Booking confirmation is processing");
      expect(venueHtml).toContain("Review the pending booking");
      expect(venueHtml).not.toContain("Manage this open date");
      expect(venueHtml).not.toContain("Save changes");
      expect(venueHtml).not.toContain("Close this listing");
      expect(venueHtml).not.toContain("Send firm offer");

      const visitorHtml = await renderSlot(futureSlotId, visitor.ownerUserId);
      expect(visitorHtml).toContain("Apply for this gig");
    } finally {
      const threadIds = (
        await db()
          .select({ id: schema.threads.id })
          .from(schema.threads)
          .where(eq(schema.threads.subjectId, bookingId))
      ).map((thread) => thread.id);
      if (threadIds.length > 0) {
        await db().delete(schema.messages).where(inArray(schema.messages.threadId, threadIds));
        await db()
          .delete(schema.threadParticipants)
          .where(inArray(schema.threadParticipants.threadId, threadIds));
        await db().delete(schema.threads).where(inArray(schema.threads.id, threadIds));
      }
      await db()
        .delete(schema.bookings)
        .where(eq(schema.bookings.id, bookingId));
      await db()
        .update(schema.applications)
        .set({ status: "submitted", declineReason: null })
        .where(eq(schema.applications.id, futureApplicationId));
    }
  });
});
