import { BOOKING_STATES, newId } from "@gigit/domain";
import type { BookingState } from "@gigit/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./client.js";
import { reviewableProfileReviews } from "./reviews.js";
import {
  bookings,
  performers,
  reviews,
  slots,
  users,
  venues,
} from "./schema.js";

describe("reviewable profile reviews (integration)", () => {
  const venueUserId = newId("user");
  const performerUserId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: venueUserId, email: `${venueUserId}@t.test` },
      { id: performerUserId, email: `${performerUserId}@t.test` },
    ]);
    await d.insert(venues).values({
      id: venueId,
      ownerUserId: venueUserId,
      kind: "bar",
      name: "Review Projection Room",
      metro: "review-projection",
      lat: 43,
      lng: -88,
    });
    await d.insert(performers).values({
      id: performerId,
      ownerUserId: performerUserId,
      kind: "band",
      name: "Review Projection Act",
      homeMetro: "review-projection",
    });

    for (const state of BOOKING_STATES) {
      const slotId = newId("slot");
      const startsAt = new Date("2026-06-01T19:00:00.000Z");
      await d.insert(slots).values({
        id: slotId,
        venueId,
        metro: "review-projection",
        startsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 40_000,
        status: "filled",
      });
      const bookingId = newId("booking");
      await d.insert(bookings).values({
        id: bookingId,
        slotId,
        performerId,
        venueId,
        state,
        terms: {
          amountCents: 40_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 7_200_000).toISOString(),
        },
        offerExpiresAt: new Date("2026-05-01T00:00:00.000Z"),
        agreementTemplateVer: "v1",
      });
      await d.insert(reviews).values([
        {
          id: newId("message"),
          bookingId,
          authorRole: "venue",
          ratings: { overall: 5 },
          body: `venue-${state}`,
        },
        {
          id: newId("message"),
          bookingId,
          authorRole: "performer",
          ratings: { overall: 4 },
          body: `performer-${state}`,
        },
      ]);
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it.each([
    ["performer", performerId],
    ["venue", venueId],
  ] as const)("suppresses legacy invalid reviews on the %s profile", async (kind, id) => {
    const projected = await reviewableProfileReviews({ kind, id });
    expect(projected).toHaveLength(4);
    expect(new Set(projected.map((review) => review.body))).toEqual(
      new Set([
        "venue-released",
        "performer-released",
        "venue-partially_released",
        "performer-partially_released",
      ]),
    );
  });

  it("uses an explicit completed-state allowlist, not terminal-state behavior", async () => {
    const projected = await reviewableProfileReviews({
      kind: "performer",
      id: performerId,
    });
    const projectedStates = projected.map((review) =>
      review.body.replace(/^(venue|performer)-/, "") as BookingState,
    );
    expect(
      BOOKING_STATES.filter((state) => projectedStates.includes(state)),
    ).toEqual(["released", "partially_released"]);
  });
});
