import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const review = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/bookings/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("review route guards (audit #22)", () => {
  const uVenue = newId("user");
  const uBand = newId("user");
  const uStranger = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let releasedId: string;
  let confirmedId: string;

  async function seedBooking(state: string) {
    const slotId = newId("slot");
    const startsAt = new Date(Date.now() - 3 * 86_400_000);
    await db().insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "rev-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    const id = newId("booking");
    await db().insert(schema.bookings).values({
      id,
      slotId,
      performerId,
      venueId,
      state,
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(),
      agreementTemplateVer: "v1",
    });
    return id;
  }

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values(
      [uVenue, uBand, uStranger].map((id) => ({ id, email: `${id}@t.test` })),
    );
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "Review Bar",
      metro: "rev-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "Review Band",
      homeMetro: "rev-tv",
    });
    releasedId = await seedBooking("released");
    confirmedId = await seedBooking("confirmed");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("201 for a party on a terminal booking, then 409 on a second review by the same side", async () => {
    as(uVenue);
    expect((await review(releasedId, { ratings: { overall: 5 }, body: "great room" })).status).toBe(201);
    expect((await review(releasedId, { ratings: { overall: 4 } })).status).toBe(409); // dup author
  });

  it("403 for a non-party", async () => {
    as(uStranger);
    expect((await review(releasedId, { ratings: { overall: 5 } })).status).toBe(403);
  });

  it("409 for a booking that isn't complete yet (non-terminal)", async () => {
    as(uBand);
    expect((await review(confirmedId, { ratings: { overall: 5 } })).status).toBe(409);
  });

  it("422 when ratings.overall is missing; 401 unauthenticated", async () => {
    as(uBand);
    expect((await review(releasedId, { ratings: { draw: 5 } })).status).toBe(422);
    as(null);
    expect((await review(releasedId, { ratings: { overall: 5 } })).status).toBe(401);
  });
});
