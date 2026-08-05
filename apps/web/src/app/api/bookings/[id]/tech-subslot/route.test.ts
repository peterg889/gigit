import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq, inArray } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";

describe("create sound job route", () => {
  const venueOwnerId = newId("user");
  const performerOwnerId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const slotId = newId("slot");
  const bookingId = newId("booking");
  const startsAt = new Date(Date.now() + 10 * 86_400_000);

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: venueOwnerId, email: `${venueOwnerId}@create-sound.test` },
      { id: performerOwnerId, email: `${performerOwnerId}@create-sound.test` },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Create Sound Room",
      metro: "create-sound",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      paInventory: { hasPA: false },
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwnerId,
      kind: "band",
      name: "Create Sound Act",
      homeMetro: "create-sound",
      techNeeds: { inputs: 6 },
    });
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "create-sound",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 40_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId,
      venueId,
      state: "confirmed",
      terms: {
        amountCents: 40_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(
          startsAt.getTime() + 2 * 3_600_000,
        ).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  const create = (payer: "venue" | "performer") =>
    POST(
      new Request(`http://test/api/bookings/${bookingId}/tech-subslot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payer, budgetCents: 15_000 }),
      }),
      { params: Promise.resolve({ id: bookingId }) },
    );

  it("returns one clean conflict and never emits a second creation event", async () => {
    sessionUserId.mockResolvedValue(venueOwnerId);
    const created = await create("venue");
    expect(created.status).toBe(201);
    const firstBody = await created.json();

    const duplicate = await create("performer");
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: {
        code: "tech_subslot_already_active",
        message:
          "This booking already has an active sound job. Open it instead of posting another.",
      },
    });

    const active = await db()
      .select({ id: schema.techSubslots.id })
      .from(schema.techSubslots)
      .where(
        and(
          eq(schema.techSubslots.bookingId, bookingId),
          inArray(schema.techSubslots.state, ["open", "booked"]),
        ),
      );
    expect(active).toEqual([{ id: firstBody.subslotId }]);
    const creationEvents = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.subjectId, firstBody.subslotId),
          eq(schema.events.kind, "subslot.created"),
        ),
      );
    expect(creationEvents).toHaveLength(1);
  });
});
