import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (userId: string | null) => sessionUserId.mockResolvedValue(userId);
const book = (subslotId: string, techId: string) =>
  POST(
    new Request(`http://test/api/tech-subslots/${subslotId}/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ techId }),
    }),
    { params: Promise.resolve({ id: subslotId }) },
  );

describe("sound-job applicant booking route", () => {
  const venueOwner = newId("user");
  const performerOwner = newId("user");
  const firstTechOwner = newId("user");
  const secondTechOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const firstTechId = newId("tech");
  const secondTechId = newId("tech");
  let bookingId: string;
  let subslotId: string;

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values(
      [venueOwner, performerOwner, firstTechOwner, secondTechOwner].map(
        (id) => ({ id, email: `${id}@book-sound.test` }),
      ),
    );
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwner,
      kind: "bar",
      name: "Sound Booking Room",
      metro: "sound-booking",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwner,
      kind: "band",
      name: "Sound Booking Act",
      homeMetro: "sound-booking",
    });
    await d.insert(schema.techs).values([
      {
        id: firstTechId,
        ownerUserId: firstTechOwner,
        name: "First Sound Applicant",
        gear: "full_rig",
      },
      {
        id: secondTechId,
        ownerUserId: secondTechOwner,
        name: "Second Sound Applicant",
        gear: "partial",
      },
    ]);
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    const slotId = newId("slot");
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "sound-booking",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    bookingId = newId("booking");
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    subslotId = newId("slot");
    await d.insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 12_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await d.insert(schema.techSubslotApplications).values([
      {
        id: newId("application"),
        subslotId,
        techId: firstTechId,
      },
      {
        id: newId("application"),
        subslotId,
        techId: secondTechId,
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("books the selected pending applicant and truthfully closes the loser", async () => {
    as(venueOwner);
    const response = await book(subslotId, secondTechId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "booked" });

    const [subslot] = await db()
      .select({
        state: schema.techSubslots.state,
        techId: schema.techSubslots.techId,
      })
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, subslotId));
    expect(subslot).toEqual({ state: "booked", techId: secondTechId });
    const applications = await db()
      .select({
        techId: schema.techSubslotApplications.techId,
        status: schema.techSubslotApplications.status,
      })
      .from(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.subslotId, subslotId));
    expect(applications).toEqual(
      expect.arrayContaining([
        { techId: firstTechId, status: "declined" },
        { techId: secondTechId, status: "booked" },
      ]),
    );
    const [loserEvent] = await db()
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, subslotId),
          eq(schema.events.kind, "subslot.application_declined"),
        ),
      );
    expect(loserEvent?.payload).toMatchObject({
      techId: firstTechId,
      reason: "another_tech_booked",
      effects: [
        {
          kind: "notify",
          template: "subslot_application_declined",
          to: "applicant",
        },
      ],
    });
  });

  it("returns an actionable conflict and preserves the application for an overlapping gig", async () => {
    const bookedStartsAt = new Date(Date.now() + 20 * 86_400_000);
    const startsAt = new Date(bookedStartsAt.getTime() + 60 * 60_000);
    const bookedSlotId = newId("slot");
    const bookedBookingId = newId("booking");
    const bookedSubslotId = newId("slot");
    const overlappingSlotId = newId("slot");
    const overlappingBookingId = newId("booking");
    const overlappingSubslotId = newId("slot");
    await db().insert(schema.slots).values([
      {
        id: bookedSlotId,
        venueId,
        metro: "sound-booking",
        startsAt: bookedStartsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000,
        status: "filled",
      },
      {
        id: overlappingSlotId,
        venueId,
        metro: "sound-booking",
        startsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000,
        status: "filled",
      },
    ]);
    await db().insert(schema.bookings).values([
      {
        id: bookedBookingId,
        slotId: bookedSlotId,
        performerId,
        venueId,
        state: "confirmed",
        terms: {
          amountCents: 30_000,
          startsAt: bookedStartsAt.toISOString(),
          endsAt: new Date(
            bookedStartsAt.getTime() + 2 * 60 * 60_000,
          ).toISOString(),
        },
        offerExpiresAt: new Date(bookedStartsAt.getTime() - 86_400_000),
      },
      {
        id: overlappingBookingId,
        slotId: overlappingSlotId,
        performerId,
        venueId,
        state: "confirmed",
        terms: {
          amountCents: 30_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + 2 * 60 * 60_000,
          ).toISOString(),
        },
        offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
      },
    ]);
    await db().insert(schema.techSubslots).values({
      id: bookedSubslotId,
      bookingId: bookedBookingId,
      payer: "venue",
      budgetCents: 11_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
      state: "booked",
      techId: firstTechId,
    });
    await db().insert(schema.techSubslots).values({
      id: overlappingSubslotId,
      bookingId: overlappingBookingId,
      payer: "venue",
      budgetCents: 11_000,
      needs: { verdict: "tech_needed", gaps: ["operator"], inputs: 4 },
    });
    await db().insert(schema.techSubslotApplications).values({
      id: newId("application"),
      subslotId: overlappingSubslotId,
      techId: firstTechId,
    });

    as(venueOwner);
    const response = await book(overlappingSubslotId, firstTechId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "tech_unavailable",
        message:
          "That sound tech is already booked for an overlapping gig. Choose another tech or a different time.",
      },
    });
    const [job] = await db()
      .select({ state: schema.techSubslots.state, techId: schema.techSubslots.techId })
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, overlappingSubslotId));
    const [application] = await db()
      .select({ status: schema.techSubslotApplications.status })
      .from(schema.techSubslotApplications)
      .where(eq(schema.techSubslotApplications.subslotId, overlappingSubslotId));
    expect(job).toEqual({ state: "open", techId: null });
    expect(application?.status).toBe("submitted");
  });

  it("returns 404 and leaves an open job unchanged when the tech never applied", async () => {
    const startsAt = new Date(Date.now() + 12 * 86_400_000);
    const freshSlotId = newId("slot");
    const freshBookingId = newId("booking");
    await db().insert(schema.slots).values({
      id: freshSlotId,
      venueId,
      metro: "sound-booking",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: freshBookingId,
      slotId: freshSlotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
    const freshSubslotId = newId("slot");
    await db().insert(schema.techSubslots).values({
      id: freshSubslotId,
      bookingId: freshBookingId,
      payer: "venue",
      budgetCents: 9_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 2 },
    });

    as(venueOwner);
    const response = await book(freshSubslotId, firstTechId);
    expect(response.status).toBe(404);
    const [subslot] = await db()
      .select({ state: schema.techSubslots.state })
      .from(schema.techSubslots)
      .where(eq(schema.techSubslots.id, freshSubslotId));
    expect(subslot?.state).toBe("open");
  });
});
