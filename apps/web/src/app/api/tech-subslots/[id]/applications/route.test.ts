import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

const as = (uid: string | null) => sessionUserId.mockResolvedValue(uid);
const apply = (id: string, body: unknown = {}) =>
  POST(
    new Request(`http://test/x/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/**
 * Tech sub-slot apply: a re-apply by the same tech must 409, not fabricate a
 * 201 with an id that was never inserted (audit edgecases #8).
 */
describe("tech sub-slot apply route", () => {
  const uTech = newId("user");
  const uVenue = newId("user");
  const uBand = newId("user");
  const uStranger = newId("user");
  const techId = newId("tech");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let openSubslot: string;
  let closedSubslot: string;

  async function seedSubslot(state: string): Promise<string> {
    const d = db();
    const slotId = newId("slot");
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "ts-tv",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    const bookingId = newId("booking");
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(),
      agreementTemplateVer: "v1",
    });
    const subslotId = newId("slot");
    await d.insert(schema.techSubslots).values({
      id: subslotId,
      bookingId,
      payer: "venue",
      budgetCents: 25_000,
      needs: { verdict: "tech_needed", gaps: [], inputs: 4 },
      state,
    });
    return subslotId;
  }

  beforeAll(async () => {
    const d = db();
    await d
      .insert(schema.users)
      .values(
        [uTech, uVenue, uBand, uStranger].map((id) => ({ id, email: `${id}@t.test` })),
      );
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uVenue,
      kind: "bar",
      name: "TS Bar",
      metro: "ts-tv",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uBand,
      kind: "band",
      name: "TS Band",
      homeMetro: "ts-tv",
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: uTech,
      name: "TS Tech",
      gear: "full_rig",
    });
    openSubslot = await seedSubslot("open");
    closedSubslot = await seedSubslot("booked");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("first apply 201, second apply by the same tech 409 (no fabricated id)", async () => {
    as(uTech);
    expect((await apply(openSubslot, { note: "I have a rig" })).status).toBe(201);
    expect((await apply(openSubslot)).status).toBe(409);
  });

  it("403 without a tech profile, 409 when the sub-slot isn't open, 401 unauthenticated", async () => {
    as(uStranger);
    expect((await apply(openSubslot)).status).toBe(403);
    as(uTech);
    expect((await apply(closedSubslot)).status).toBe(409);
    as(null);
    expect((await apply(openSubslot)).status).toBe(401);
  });
});
