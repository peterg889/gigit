import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import { newId } from "@gigit/domain";
import { closeDb, db, getPool, schema } from "@gigit/db";
import { drainOutboxOnce } from "./index.js";
import { pendingReviewAudience } from "./notify.js";

/**
 * Reviews are the trust flywheel — with payments off they're most of what a
 * profile is worth. The form and the double-blind rules were both built, but
 * nothing ever asked anyone to write one, so reaching a reviewable state was
 * the end of the story. The prompt is armed from the outbox fan-out (like the
 * day-before reminder) rather than the domain reducer, so a stub boss that
 * records `send` calls is exactly the seam to test.
 */
describe("post-gig review prompt", () => {
  const userV = newId("user");
  const userP = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const slotId = newId("slot");
  const bookingId = newId("booking");

  const sends: { queue: string; data: unknown; opts: PgBoss.SendOptions }[] = [];
  const recordingBoss = {
    send: async (queue: string, data: unknown, opts: PgBoss.SendOptions) => {
      sends.push({ queue, data, opts });
      return null;
    },
  } as unknown as PgBoss;

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: userV, email: `${userV}@t.test` },
      { id: userP, email: `${userP}@t.test` },
    ]);
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: userV,
      kind: "bar",
      name: "Review Bar",
      metro: "reviewville",
      lat: 43,
      lng: -88,
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: userP,
      kind: "band",
      name: "Review Band",
      homeMetro: "reviewville",
    });
    const startsAt = new Date(Date.now() - 2 * 86_400_000);
    await d.insert(schema.slots).values({
      id: slotId,
      venueId,
      metro: "reviewville",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await d.insert(schema.bookings).values({
      id: bookingId,
      slotId,
      venueId,
      performerId,
      state: "released",
      offerExpiresAt: startsAt,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  /** Park the backlog, inject one transition event, drain it. */
  async function drainTransitionTo(to: string) {
    sends.length = 0;
    await getPool().query(
      `update events set dispatched_at = now()
       where dispatched_at is null and dead_lettered_at is null`,
    );
    await getPool().query(
      `insert into events (actor, kind, subject_type, subject_id, payload)
       values ($1,'booking.transition','booking',$2,$3::jsonb)`,
      ["worker", bookingId, JSON.stringify({ to, effects: [] })],
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainOutboxOnce(recordingBoss);
    spy.mockRestore();
  }

  it("arms a delayed, deduped prompt when a booking becomes reviewable", async () => {
    await drainTransitionTo("released");
    const prompt = sends.find((s) => s.queue === "review-prompts");
    expect(prompt).toBeDefined();
    expect(prompt!.data).toEqual({ bookingId });
    // a day out, so it doesn't stack on the wrap-up notice
    expect((prompt!.opts.startAfter as Date).getTime()).toBeGreaterThan(
      Date.now() + 20 * 3_600_000,
    );
    // re-delivery of the same event must not queue a second ask
    expect(prompt!.opts.singletonKey).toBe(`${bookingId}:review_prompt`);
  });

  it("does not ask about a gig that never happened", async () => {
    await drainTransitionTo("cancelled_by_venue");
    expect(sends.some((s) => s.queue === "review-prompts")).toBe(false);
  });

  it("asks only the side that still owes a review, then stops", async () => {
    expect(await pendingReviewAudience(bookingId)).toBe("both");

    await db().insert(schema.reviews).values({
      id: newId("message"), // reviews reuse the ULID generator
      bookingId,
      authorRole: "performer",
      ratings: { overall: 5 },
    });
    expect(await pendingReviewAudience(bookingId)).toBe("venue");

    await db().insert(schema.reviews).values({
      id: newId("message"), // reviews reuse the ULID generator
      bookingId,
      authorRole: "venue",
      ratings: { overall: 4 },
    });
    // both sides done → a queued prompt drops instead of nagging
    expect(await pendingReviewAudience(bookingId)).toBeNull();
  });
});
