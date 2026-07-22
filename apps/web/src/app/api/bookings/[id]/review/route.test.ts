import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOOKING_STATES, newId } from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
import { and, eq } from "drizzle-orm";

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
  const bookingIds = new Map<BookingState, string>();

  async function seedBooking(state: BookingState) {
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
    for (const state of BOOKING_STATES) {
      bookingIds.set(state, await seedBooking(state));
    }
  });
  afterAll(async () => {
    await closeDb();
  });

  it("201 for a party on a completed gig, then 409 on a second review by the same side", async () => {
    as(uVenue);
    const releasedId = bookingIds.get("released")!;
    expect((await review(releasedId, { ratings: { overall: 5 }, body: "great room" })).status).toBe(201);
    expect((await review(releasedId, { ratings: { overall: 4 } })).status).toBe(409); // dup author
  });

  it("accepts every completed-gig outcome", async () => {
    as(uBand);
    for (const state of ["released", "partially_released"] as const) {
      const response = await review(bookingIds.get(state)!, {
        ratings: { overall: 5 },
        body: `review for ${state}`,
      });
      expect(response.status, state).toBe(201);
    }
  });

  it("rejects active, collapsed, cancelled, refunded, and unresolved bookings without side effects", async () => {
    as(uBand);
    const reviewable = new Set<BookingState>([
      "released",
      "partially_released",
    ]);
    for (const state of BOOKING_STATES.filter((item) => !reviewable.has(item))) {
      const bookingId = bookingIds.get(state)!;
      const response = await review(bookingId, {
        ratings: { overall: 5 },
      });
      expect(response.status, state).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "conflict",
          message: "reviews open after a completed gig",
        },
      });
      expect(
        await db()
          .select()
          .from(schema.reviews)
          .where(eq(schema.reviews.bookingId, bookingId)),
        state,
      ).toHaveLength(0);
      expect(
        await db()
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.subjectId, bookingId),
              eq(schema.events.kind, "review.submitted"),
            ),
          ),
        state,
      ).toHaveLength(0);
    }
  });

  it("403 for a non-party", async () => {
    as(uStranger);
    expect((await review(bookingIds.get("released")!, { ratings: { overall: 5 } })).status).toBe(403);
  });

  it("422 when ratings.overall is missing; 401 unauthenticated", async () => {
    as(uBand);
    expect((await review(bookingIds.get("released")!, { ratings: { draw: 5 } })).status).toBe(422);
    as(null);
    expect((await review(bookingIds.get("released")!, { ratings: { overall: 5 } })).status).toBe(401);
  });
});
