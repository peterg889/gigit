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

  // A second, untouched booking that has NO sub-slot yet — the only state in
  // which the page offers to post one. The fixture above always has an active
  // child, so it can only ever exercise the absence of the form.
  let postableVenue: Awaited<ReturnType<typeof makeVenue>>;
  let postablePerformer: Awaited<ReturnType<typeof makePerformer>>;
  const postableSlotId = newId("slot");
  const postableBookingId = newId("booking");

  // Two more untouched bookings, one per end of the verdict colour scale. Both
  // need their own room and act because the verdict is computed from the room's
  // PA and the act's input list, so the fixture IS the assertion.
  let unknownVenue: Awaited<ReturnType<typeof makeVenue>>;
  let unknownPerformer: Awaited<ReturnType<typeof makePerformer>>;
  const unknownSlotId = newId("slot");
  const unknownBookingId = newId("booking");
  let coveredVenue: Awaited<ReturnType<typeof makeVenue>>;
  let coveredPerformer: Awaited<ReturnType<typeof makePerformer>>;
  const coveredSlotId = newId("slot");
  const coveredBookingId = newId("booking");

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

    // Real numbers, not a hand-written verdict: a house desk two channels short
    // and nobody on it is what `soundPlan` turns into "Needs a tech" plus two
    // named gaps. Deliberately NOT a rig shortfall — the two verdicts differ by
    // three words, and only a fixture that can produce one and not the other
    // can tell them apart.
    postableVenue = await makeVenue({
      name: "Postable Sound Room",
      paInventory: { hasPA: true, mixerChannels: 4, hasOperator: false },
    });
    postablePerformer = await makePerformer({
      name: "Postable Sound Act",
      techNeeds: { inputs: 6 },
    });
    await d.insert(schema.slots).values({
      id: postableSlotId,
      venueId: postableVenue.id,
      metro: "postable-sound-history",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 50_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: postableBookingId,
      slotId: postableSlotId,
      performerId: postablePerformer.id,
      venueId: postableVenue.id,
      state: "confirmed",
      terms: {
        amountCents: 50_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });

    // A room that answered every equipment question except who runs the desk,
    // and an act whose needs the gear covers. Nothing is short — the only thing
    // wrong is that nobody has said, which is the whole `unknown` verdict.
    unknownVenue = await makeVenue({
      name: "Unanswered Sound Room",
      paInventory: { hasPA: true, mixerChannels: 8, micsAvailable: 4, monitors: 2 },
    });
    unknownPerformer = await makePerformer({
      name: "Unanswered Sound Act",
      techNeeds: { inputs: 4, micsNeeded: 2 },
    });
    // The same room with the operator question answered yes. One field apart
    // from the fixture above, so the two verdicts cannot both be a coincidence.
    coveredVenue = await makeVenue({
      name: "Settled Sound Room",
      paInventory: {
        hasPA: true,
        mixerChannels: 8,
        micsAvailable: 4,
        monitors: 2,
        hasOperator: true,
      },
    });
    coveredPerformer = await makePerformer({
      name: "Settled Sound Act",
      techNeeds: { inputs: 4, micsNeeded: 2 },
    });
    await d.insert(schema.slots).values(
      [
        { id: unknownSlotId, venueId: unknownVenue.id, metro: "unanswered-sound" },
        { id: coveredSlotId, venueId: coveredVenue.id, metro: "settled-sound" },
      ].map((s) => ({
        ...s,
        startsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 50_000,
        status: "filled",
      })),
    );
    await d.insert(schema.bookings).values(
      [
        {
          id: unknownBookingId,
          slotId: unknownSlotId,
          performerId: unknownPerformer.id,
          venueId: unknownVenue.id,
        },
        {
          id: coveredBookingId,
          slotId: coveredSlotId,
          performerId: coveredPerformer.id,
          venueId: coveredVenue.id,
        },
      ].map((b) => ({
        ...b,
        state: "confirmed",
        terms: {
          amountCents: 50_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
      })),
    );

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

  /**
   * The positive counterpart to the `not.toContain("Post the sound job")`
   * assertions above. Those pass just as happily when the whole sound card is
   * deleted, which is exactly how the differentiator could ship switched off:
   * a confirmed gig with a gap in its sound plan and no way to hire anyone.
   */
  it("offers the sound job and names the gaps when the plan needs a tech", async () => {
    sessionUserId.mockResolvedValue(postableVenue.ownerUserId);
    const html = renderToStaticMarkup(
      await BookingPage({ params: Promise.resolve({ id: postableBookingId }) }),
    );

    expect(html).toContain("Post the sound job");
    expect(html).toContain("Who pays the tech");
    expect(html).toContain("Tech pay, in dollars");
    // The verdict the engine actually produced from the room and the act, not
    // the neighbouring one: "Needs a tech" is a PREFIX of "Needs a tech and a
    // rig", so the absence assertion is the half that carries the meaning.
    expect(html).toContain("Needs a tech");
    expect(html).not.toContain("Needs a tech and a rig");
    // Both gaps, in the engine's own words. A tech deciding whether to take the
    // night needs to know it is a channel shortfall AND an empty desk.
    expect(html).toContain(
      "mixer has 4 channels, act needs 6; no one to run sound",
    );
  });

  /**
   * The verdict badge carries its meaning in its colour, and `soundVerdictClass`
   * was imported by no test at all. An `unknown` plan rendered as a bare `badge`
   * reads as a settled answer, so the one gig on the calendar whose sound nobody
   * has actually agreed looks identical to the ones that are handled — and the
   * gap line is the only place the venue is told which question is open.
   */
  it("flags an unanswered sound plan as a warning and names the open question", async () => {
    sessionUserId.mockResolvedValue(unknownVenue.ownerUserId);
    const html = renderToStaticMarkup(
      await BookingPage({ params: Promise.resolve({ id: unknownBookingId }) }),
    );

    expect(html).toContain('<span class="badge warn">Sound not confirmed</span>');
    expect(html).toContain("the room hasn&#x27;t said whether anyone runs sound");
    // Not a shortfall: nothing on the gear list is short, so the two "needed"
    // verdicts must not appear — this is uncertainty, not a job spec.
    expect(html).not.toContain("Needs a tech");
    // Uncertainty still gets the hire route. "Nobody has said" is exactly when a
    // venue wants the option, and it is the one verdict that could plausibly be
    // treated as good enough to hide it.
    expect(html).toContain("Post the sound job");
  });

  /**
   * The other end of the same scale. A covered plan is the only one that earns
   * `badge good`, and it must not carry a gap list or a hire form — offering to
   * post a job for a night that needs nobody is how the differentiator turns
   * into noise the venue learns to ignore.
   */
  it("marks a covered sound plan good with no gaps and no job to post", async () => {
    sessionUserId.mockResolvedValue(coveredVenue.ownerUserId);
    const html = renderToStaticMarkup(
      await BookingPage({ params: Promise.resolve({ id: coveredBookingId }) }),
    );

    expect(html).toContain('<span class="badge good">Sound covered</span>');
    expect(html).not.toContain("badge warn");
    // No gap list at all: the gaps render as a muted span welded to the badge,
    // so this catches a gap block that stops being conditional as well as a
    // verdict that starts reporting phantom shortfalls.
    expect(html).not.toMatch(/Sound covered<\/span>\s*<span class="muted">/);
    expect(html).not.toContain("Post the sound job");
    expect(html).not.toContain("Tech pay, in dollars");
  });
});
