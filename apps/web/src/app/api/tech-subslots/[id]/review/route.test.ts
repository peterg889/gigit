import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (userId: string | null) => sessionUserId.mockResolvedValue(userId);
const review = (id: string) =>
  POST(
    new Request("http://test/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ratings: { overall: 5 }, body: "Solid work." }),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("sound booking reviews", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uTech = newId("user");
  const uOther = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");
  let releasedId: string;
  let bookedId: string;

  async function subslot(state: "released" | "booked") {
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const id = newId("slot");
    const startsAt = new Date(Date.now() - 86_400_000);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "review-metro",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "released",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 7_200_000).toISOString(),
      },
      offerExpiresAt: startsAt,
    });
    await db().insert(schema.techSubslots).values({
      id,
      bookingId,
      payer: "venue",
      budgetCents: 15_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      techId,
      state,
    });
    return id;
  }

  beforeAll(async () => {
    await db().insert(schema.users).values(
      [uVenue, uBand, uTech, uOther].map((id) => ({ id, email: id + "@review.test" })),
    );
    await db().insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Review Room",
      metro: "review-metro",
      lat: 43,
      lng: -88,
    });
    await db().insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Review Act",
      homeMetro: "review-metro",
    });
    await db().insert(schema.techs).values({
      id: techId,
      ownerUserId: uTech,
      name: "Review Tech",
      gear: "full_rig",
    });
    releasedId = await subslot("released");
    bookedId = await subslot("booked");
  });

  afterAll(async () => closeDb());

  it("accepts one review from the payer and one from the booked tech", async () => {
    as(uVenue);
    expect((await review(releasedId)).status).toBe(201);
    expect((await review(releasedId)).status).toBe(409);
    as(uTech);
    expect((await review(releasedId)).status).toBe(201);
  });

  it("rejects outsiders and reviews before completion", async () => {
    as(uOther);
    expect((await review(releasedId)).status).toBe(403);
    as(uTech);
    expect((await review(bookedId)).status).toBe(409);
  });
});
