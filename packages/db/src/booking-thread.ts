import { and, eq } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { appendEvent } from "./events.js";
import * as schema from "./schema.js";
import { newId } from "@gigit/domain";

/**
 * Ensure the two booking parties have a shared conversation from the moment an
 * offer is created. Cold DMs remain disabled, while every proposed or accepted
 * engagement has one place to clarify timing, load-in, and term changes.
 *
 * Idempotent across processes: safe to call from an at-least-once outbox
 * dispatch. New offers call the transaction-scoped form below so the offer and
 * its conversation commit together.
 */
export async function ensureBookingThread(
  bookingId: string,
  actor: string,
): Promise<string | null> {
  return db().transaction((tx) => ensureBookingThreadInTx(tx, bookingId, actor));
}

/** Ensure a booking conversation inside an existing booking write transaction. */
export async function ensureBookingThreadInTx(
  tx: Tx,
  bookingId: string,
  actor: string,
): Promise<string | null> {
  const [booking] = await tx
    .select({
      venueOwner: schema.venues.ownerUserId,
      performerOwner: schema.performers.ownerUserId,
    })
    .from(schema.bookings)
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .where(eq(schema.bookings.id, bookingId));
  if (!booking) return null;

  const candidateId = newId("thread");
  const inserted = await tx
    .insert(schema.threads)
    .values({
      id: candidateId,
      scope: "booking",
      subjectId: bookingId,
      createdByUserId: actor === "worker" || actor === "system" ? null : actor,
    })
    // The partial unique index is the concurrency boundary. Omitting a target
    // lets PostgreSQL apply it even though it is a partial index.
    .onConflictDoNothing()
    .returning({ id: schema.threads.id });

  if (inserted.length === 0) {
    const [existing] = await tx
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.scope, "booking"),
          eq(schema.threads.subjectId, bookingId),
        ),
      );
    return existing?.id ?? null;
  }

  const threadId = inserted[0]!.id;
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
