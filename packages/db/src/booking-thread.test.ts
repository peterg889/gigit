import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { bookingThreadId, ensureBookingThread } from "./booking-thread.js";
import {
  bookings,
  performers,
  slots,
  threadParticipants,
  threads,
  users,
  venues,
} from "./schema.js";

/**
 * `threads.scope` has always declared `booking` and nothing ever wrote one, which
 * mattered more than an unused enum value: a performer cannot open a thread to a
 * venue at all (deliberate — no cold DMs), so an act could not message a venue
 * even one they had a CONFIRMED BOOKING with. At the moment a deal closed the
 * product handed both sides each other's phone number and offered no on-platform
 * channel, while /help told them to "agree in the booking thread".
 */
describe("booking conversation", () => {
  const uVenue = newId("user");
  const uAct = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  let seq = 0;

  beforeAll(async () => {
    const d = db();
    await d.insert(users).values([
      { id: uVenue, email: `${uVenue}@t.test` },
      { id: uAct, email: `${uAct}@t.test` },
    ]);
    await d.insert(venues).values({
    addressLine1: "1 Test St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53202",
    timeZone: "America/Chicago",
      id: venueId, ownerUserId: uVenue, kind: "bar",
      name: "Thread Room", metro: "bt-tv", lat: 43, lng: -88,
    });
    await d.insert(performers).values({
      id: performerId, ownerUserId: uAct, kind: "band",
      name: "Thread Act", homeMetro: "bt-tv",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  async function confirmedBooking() {
    const d = db();
    const slotId = newId("slot");
    const bookingId = newId("booking");
    const startsAt = new Date(Date.now() + (20 + seq++) * 86_400_000);
    await d.insert(slots).values({
      id: slotId, venueId, metro: "bt-tv", startsAt,
      durationMinutes: 120, format: "music", budgetCents: 30_000, status: "filled",
    });
    await d.insert(bookings).values({
      id: bookingId, slotId, venueId, performerId, state: "confirmed",
      offerExpiresAt: startsAt,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    });
    return bookingId;
  }

  it("opens a thread with BOTH parties, so either side can start talking", async () => {
    const bookingId = await confirmedBooking();
    const threadId = await ensureBookingThread(bookingId, "worker");
    expect(threadId).toBeTruthy();

    const [thread] = await db()
      .select({ scope: threads.scope, subjectId: threads.subjectId })
      .from(threads)
      .where(eq(threads.id, threadId!));
    expect(thread).toEqual({ scope: "booking", subjectId: bookingId });

    // The messages route is participant-scoped, so membership IS the permission —
    // this is what makes an act able to reach the venue.
    const parts = await db()
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, threadId!));
    expect(parts.map((p) => p.userId).sort()).toEqual([uVenue, uAct].sort());
  });

  it("is idempotent, because an at-least-once outbox will call it twice", async () => {
    const bookingId = await confirmedBooking();
    const first = await ensureBookingThread(bookingId, "worker");
    const second = await ensureBookingThread(bookingId, "worker");
    expect(second).toBe(first);

    const all = await db()
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.scope, "booking"), eq(threads.subjectId, bookingId)));
    expect(all).toHaveLength(1);
  });

  it("creates exactly one thread when multiple processes race", async () => {
    const bookingId = await confirmedBooking();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => ensureBookingThread(bookingId, "worker")),
    );
    expect(new Set(ids)).toEqual(new Set([ids[0]]));

    const all = await db()
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.scope, "booking"), eq(threads.subjectId, bookingId)));
    expect(all).toHaveLength(1);

    const parts = await db()
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, all[0]!.id));
    expect(parts.map((p) => p.userId).sort()).toEqual([uVenue, uAct].sort());
  });

  it("bookingThreadId finds it, and returns null before one exists", async () => {
    const bookingId = await confirmedBooking();
    expect(await bookingThreadId(bookingId)).toBeNull();
    const threadId = await ensureBookingThread(bookingId, uVenue);
    expect(await bookingThreadId(bookingId)).toBe(threadId);
  });

  it("declines to invent a thread for a booking that doesn't exist", async () => {
    expect(await ensureBookingThread(newId("booking"), "worker")).toBeNull();
  });
});
