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

import SoundBookingPage from "./page";
import { DELETE as withdrawApplication } from "@/app/api/tech-subslots/[id]/applications/route";

describe("sound detail parent eligibility", () => {
  let venue: Awaited<ReturnType<typeof makeVenue>>;
  let performer: Awaited<ReturnType<typeof makePerformer>>;
  let techOwnerId: string;
  const techId = newId("tech");
  const slotId = newId("slot");
  const bookingId = newId("booking");
  const subslotId = newId("slot");
  const applicationId = newId("application");
  const startsAt = new Date(Date.now() + 10 * 86_400_000);

  beforeAll(async () => {
    venue = await makeVenue({
      name: "Eligibility Detail Room",
      addressLine1: "777 Eligibility Ave",
    });
    performer = await makePerformer({ name: "Eligibility Detail Act" });
    techOwnerId = await makeUser();
    const d = db();
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: techOwnerId,
      name: "Eligibility Detail Tech",
      gear: "full_rig",
    });
    await d.insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "sound-detail-eligibility",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 45_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      venueId: venue.id,
      performerId: performer.id,
      state: "confirmed",
      terms: {
        amountCents: 45_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: startsAt,
      agreementTemplateVer: "v1",
    });
    await d.insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 15_000,
      needs: {
        verdict: "tech_needed",
        gaps: ["operator"],
        inputs: 6,
        notes: "PRIVATE LOAD IN NOTE",
      },
      state: "open",
    });
    await d.insert(schema.techSubslotApplications).values({
      id: applicationId,
      subslotId,
      techId,
      note: "Available",
    });
  });

  afterAll(async () => {
    const d = db();
    await d
      .delete(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.id, applicationId));
    await d
      .delete(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    await d.delete(schema.bookings).where(eq(schema.bookings.id, bookingId));
    await d.delete(schema.slots).where(eq(schema.slots.id, slotId));
    await d.delete(schema.techs).where(eq(schema.techs.id, techId));
    await d
      .delete(schema.performers)
      .where(eq(schema.performers.id, performer.id));
    await d.delete(schema.venues).where(eq(schema.venues.id, venue.id));
    await d
      .delete(schema.users)
      .where(
        inArray(schema.users.id, [
          venue.ownerUserId,
          performer.ownerUserId,
          techOwnerId,
        ]),
      );
    vi.unstubAllGlobals();
    await closeDb();
  });

  async function renderAs(userId: string) {
    sessionUserId.mockResolvedValue(userId);
    return renderToStaticMarkup(
      await SoundBookingPage({ params: Promise.resolve({ id: subslotId }) }),
    );
  }

  it("removes stale application controls and operational details immediately", async () => {
    const liveTechView = await renderAs(techOwnerId);
    expect(liveTechView).toContain(
      "The paying side has your application and will respond here.",
    );
    expect(liveTechView).toContain("Withdraw application");
    expect(liveTechView).toContain("777 Eligibility Ave");
    expect(liveTechView).toContain("PRIVATE LOAD IN NOTE");

    const livePayerView = await renderAs(venue.ownerUserId);
    expect(livePayerView).toContain("Book this tech");

    await db()
      .update(schema.techs)
      .set({ status: "suspended" })
      .where(eq(schema.techs.id, techId));
    const suspendedProfile = await renderAs(venue.ownerUserId);
    expect(suspendedProfile).not.toContain("Book this tech");
    expect(suspendedProfile).toContain(
      "This tech is not currently available to book.",
    );
    const historicalApplicant = await renderAs(techOwnerId);
    expect(historicalApplicant).toContain("Withdraw application");


    await db()
      .update(schema.techs)
      .set({ status: "live" })
      .where(eq(schema.techs.id, techId));
    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, techOwnerId));
    const suspendedOwner = await renderAs(venue.ownerUserId);
    expect(suspendedOwner).not.toContain("Book this tech");
    expect(suspendedOwner).toContain(
      "This tech is not currently available to book.",
    );
    const inactiveApplicant = await renderAs(techOwnerId);
    expect(inactiveApplicant).toContain("sound-booking history is read-only");
    expect(inactiveApplicant).not.toContain("Withdraw application");

    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, techOwnerId));

    await db()
      .update(schema.bookings)
      .set({ state: "cancelled_by_venue" })
      .where(eq(schema.bookings.id, bookingId));

    const staleTechView = await renderAs(techOwnerId);
    expect(staleTechView).toContain(
      "This sound job is no longer open. Your application is being closed.",
    );
    expect(staleTechView).not.toContain("Withdraw application");
    expect(staleTechView).not.toContain("777 Eligibility Ave");
    expect(staleTechView).not.toContain("PRIVATE LOAD IN NOTE");

    const stalePayerView = await renderAs(venue.ownerUserId);
    expect(stalePayerView).not.toContain("Book this tech");
    expect(stalePayerView).toContain("777 Eligibility Ave");
    expect(stalePayerView).toContain("PRIVATE LOAD IN NOTE");
  });

  /**
   * This used to open by hand-writing `status: "withdrawn"`, a value the schema
   * does not define and no code path writes — withdrawal DELETEs the row. The
   * real withdrawal is exercised at the end of this file instead.
   */
  it("renders declined and closed application outcomes truthfully", async () => {
    await db()
      .update(schema.bookings)
      .set({ state: "confirmed" })
      .where(eq(schema.bookings.id, bookingId));
    await db()
      .update(schema.techSubslots)
      .set({ state: "open" })
      .where(eq(schema.techSubslots.id, subslotId));

    await db()
      .update(schema.techSubslotApplications)
      .set({ status: "declined" })
      .where(eq(schema.techSubslotApplications.id, applicationId));
    await db()
      .update(schema.techSubslots)
      .set({ state: "cancelled_with_parent" })
      .where(eq(schema.techSubslots.id, subslotId));
    const closed = await renderAs(techOwnerId);
    expect(closed).toContain("This sound job closed before you were booked.");
    expect(closed).not.toContain("filled by another tech");

    await db()
      .update(schema.techSubslots)
      .set({ state: "booked" })
      .where(eq(schema.techSubslots.id, subslotId));
    const declined = await renderAs(techOwnerId);
    expect(declined).toContain(
      "The paying side booked another tech for this sound job.",
    );
  });

  it("hides tech cancellation when the parent closed or downbeat passed", async () => {
    await db()
      .update(schema.bookings)
      .set({
        state: "confirmed",
        terms: {
          amountCents: 45_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      })
      .where(eq(schema.bookings.id, bookingId));
    await db()
      .update(schema.techSubslots)
      .set({ state: "booked", techId })
      .where(eq(schema.techSubslots.id, subslotId));
    await db()
      .update(schema.techSubslotApplications)
      .set({ status: "booked" })
      .where(eq(schema.techSubslotApplications.id, applicationId));

    await db()
      .update(schema.techs)
      .set({ status: "hidden" })
      .where(eq(schema.techs.id, techId));
    const future = await renderAs(techOwnerId);
    expect(future).toContain("Cancel sound booking");
    await db()
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.id, techOwnerId));
    const inactive = await renderAs(techOwnerId);
    expect(inactive).toContain("sound-booking history is read-only");
    expect(inactive).not.toContain("Cancel sound booking");
    await db()
      .update(schema.users)
      .set({ status: "active" })
      .where(eq(schema.users.id, techOwnerId));
    await db()
      .update(schema.techs)
      .set({ status: "live" })
      .where(eq(schema.techs.id, techId));


    await db()
      .update(schema.bookings)
      .set({ state: "cancelled_by_venue" })
      .where(eq(schema.bookings.id, bookingId));
    const parentClosed = await renderAs(techOwnerId);
    expect(parentClosed).not.toContain("Cancel sound booking");
    expect(parentClosed).toContain("cannot reopen");

    const pastStart = new Date(Date.now() - 60_000);
    await db()
      .update(schema.bookings)
      .set({
        state: "confirmed",
        terms: {
          amountCents: 45_000,
          startsAt: pastStart.toISOString(),
          endsAt: new Date(
            pastStart.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      })
      .where(eq(schema.bookings.id, bookingId));
    const afterDownbeat = await renderAs(techOwnerId);
    expect(afterDownbeat).not.toContain("Cancel sound booking");
    expect(afterDownbeat).toContain("cannot reopen");
  });

  /**
   * The state the old `withdrawn` assertions were reaching for, driven through
   * the route a tech actually clicks. `withdrawTechSubslotApplication` DELETEs
   * the row rather than flagging it, so there is no "Withdrawn" card to render:
   * the tech loses the application, the operational details and the page itself,
   * and the payer's shortlist loses them too. Asserting a stored `withdrawn`
   * status could never have caught a withdrawal that failed to delete.
   */
  it("removes the tech's application, and their access, when they withdraw", async () => {
    const futureStart = new Date(Date.now() + 12 * 86_400_000);
    await db()
      .update(schema.bookings)
      .set({
        state: "confirmed",
        terms: {
          amountCents: 45_000,
          startsAt: futureStart.toISOString(),
          endsAt: new Date(
            futureStart.getTime() + 2 * 3_600_000,
          ).toISOString(),
        },
      })
      .where(eq(schema.bookings.id, bookingId));
    await db()
      .update(schema.techSubslots)
      .set({ state: "open", techId: null })
      .where(eq(schema.techSubslots.id, subslotId));
    await db()
      .update(schema.techSubslotApplications)
      .set({ status: "submitted" })
      .where(eq(schema.techSubslotApplications.id, applicationId));

    const pending = await renderAs(techOwnerId);
    expect(pending).toContain("Application sent");
    expect(pending).toContain("Withdraw application");
    const shortlisted = await renderAs(venue.ownerUserId);
    expect(shortlisted).toContain("Eligibility Detail Tech");
    expect(shortlisted).toContain("Application received");

    sessionUserId.mockResolvedValue(techOwnerId);
    const response = await withdrawApplication(
      new Request("http://test/api/tech-subslots/" + subslotId + "/applications", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: subslotId }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawn: true });

    // Deleted, not flagged — the row the old fixture used to relabel is gone.
    const remaining = await db()
      .select({ id: schema.techSubslotApplications.id })
      .from(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.subslotId, subslotId));
    expect(remaining).toEqual([]);

    // No application, no booking party, no assignment: the page is not theirs
    // to read any more, load-in note and address included.
    await expect(renderAs(techOwnerId)).rejects.toThrow("not found");

    const afterWithdrawal = await renderAs(venue.ownerUserId);
    expect(afterWithdrawal).not.toContain("Eligibility Detail Tech");
    expect(afterWithdrawal).not.toContain("Application received");
    expect(afterWithdrawal).not.toContain("Book this tech");
  });
});
