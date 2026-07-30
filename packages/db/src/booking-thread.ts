import { and, eq } from "drizzle-orm";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import * as schema from "./schema.js";
import { newId } from "@gigit/domain";

/**
 * The conversation attached to a confirmed booking.
 *
 * `threads.scope` has always declared `booking`, and nothing ever wrote one. The
 * consequences compounded: a performer cannot open a thread to a venue at all
 * (deliberate, F5.1 — no cold DMs), which meant an act could not message a venue
 * *even one they had a confirmed booking with*. So at the moment a deal closed,
 * the product handed both sides each other's phone number and offered no
 * on-platform channel — while /help told them to "agree in the booking thread so
 * both sides have the same record".
 *
 * With no escrow, a written record of CHANGES to the deal (set time moved, load-in
 * shifted, pay renegotiated) is the closest thing to money-in-the-middle this
 * product has. It's also the strongest anti-leakage move available at this price.
 *
 * Idempotent: safe to call from an at-least-once outbox dispatch.
 */
export async function ensureBookingThread(
  bookingId: string,
  actor: string,
): Promise<string | null> {
  const d = db();
  const [existing] = await d
    .select({ id: schema.threads.id })
    .from(schema.threads)
    .where(
      and(eq(schema.threads.scope, "booking"), eq(schema.threads.subjectId, bookingId)),
    );
  if (existing) return existing.id;

  const [booking] = await d
    .select({
      venueOwner: schema.venues.ownerUserId,
      performerOwner: schema.performers.ownerUserId,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.bookings.id, bookingId));
  if (!booking) return null;

  const threadId = newId("thread");
  await d.transaction(async (tx) => {
    await tx.insert(schema.threads).values({
      id: threadId,
      scope: "booking",
      subjectId: bookingId,
      createdByUserId: actor === "worker" || actor === "system" ? null : actor,
    });
    await tx
      .insert(schema.threadParticipants)
      .values(
        [booking.venueOwner, booking.performerOwner]
          .filter((u, i, all) => u && all.indexOf(u) === i)
          .map((userId) => ({ threadId, userId })),
      );
    await appendEvent(tx, {
      actor,
      kind: "thread.booking_opened",
      subjectType: "thread",
      subjectId: threadId,
      payload: { bookingId },
    });
  });
  return threadId;
}

/** The booking's thread, if it has one. */
export async function bookingThreadId(bookingId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: schema.threads.id })
    .from(schema.threads)
    .where(
      and(eq(schema.threads.scope, "booking"), eq(schema.threads.subjectId, bookingId)),
    );
  return row?.id ?? null;
}
