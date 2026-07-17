/**
 * Account deactivation (PRD F9.x). Marketplace records remain — completed
 * bookings, reviews, disputes, and audit history must not become misleading —
 * but a departing party's LIVE commitments cannot be left dangling: the
 * counterparty would show up to a venue that left the platform, or wait on an
 * offer no one will ever answer. So deactivation first winds down everything
 * still in motion through the normal transition machinery (counterparties get
 * the same notifications as a manual cancellation), then removes the login
 * identifiers.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BookingEvent } from "@gigit/domain";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { cancelSeries } from "./series.js";
import {
  BookingNotFoundError,
  ConcurrentUpdateError,
  IllegalTransitionError,
  runBookingTransition,
} from "./transition.js";
import {
  applications,
  bookings,
  performers,
  slots,
  slotSeries,
  users,
  venues,
} from "./schema.js";

/** Cancel one booking, tolerating races: a state that moved on is fine. */
async function tryTransition(
  bookingId: string,
  event: BookingEvent,
  actor: string,
): Promise<void> {
  try {
    await runBookingTransition(bookingId, event, actor);
  } catch (e) {
    if (
      e instanceof IllegalTransitionError ||
      e instanceof ConcurrentUpdateError ||
      e instanceof BookingNotFoundError
    )
      return;
    throw e;
  }
}

export async function deactivateAccount(userId: string): Promise<void> {
  const d = db();
  const [performer] = await d
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.ownerUserId, userId));
  const [venue] = await d
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.ownerUserId, userId));

  // Live commitments end through the state machine so slots reopen, timers
  // cancel, and counterparties are notified. Gigs already played
  // (awaiting_confirmation) and open disputes keep their existing flows —
  // deactivation must not decide money questions.
  if (performer) {
    const live = await d
      .select({ id: bookings.id, state: bookings.state })
      .from(bookings)
      .where(
        and(
          eq(bookings.performerId, performer.id),
          inArray(bookings.state, ["offered", "confirmed"]),
        ),
      );
    for (const b of live)
      await tryTransition(
        b.id,
        { kind: b.state === "offered" ? "PERFORMER_DECLINED" : "PERFORMER_CANCELLED" },
        userId,
      );
    await d
      .update(applications)
      .set({ status: "withdrawn" })
      .where(
        and(
          eq(applications.performerId, performer.id),
          eq(applications.status, "submitted"),
        ),
      );
  }

  if (venue) {
    const live = await d
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.venueId, venue.id),
          inArray(bookings.state, ["offered", "confirmed"]),
        ),
      );
    for (const b of live) await tryTransition(b.id, { kind: "VENUE_CANCELLED" }, userId);

    const activeSeries = await d
      .select({ id: slotSeries.id })
      .from(slotSeries)
      .where(and(eq(slotSeries.venueId, venue.id), eq(slotSeries.status, "active")));
    for (const s of activeSeries) await cancelSeries(s.id, userId);

    // Remaining open slots (including ones the cancellations above reopened)
    // stop collecting applications nobody will ever read.
    await d.transaction(async (tx) => {
      const open = await tx
        .select({ id: slots.id })
        .from(slots)
        .where(and(eq(slots.venueId, venue.id), eq(slots.status, "open")));
      if (open.length === 0) return;
      await tx
        .update(slots)
        .set({ status: "cancelled" })
        .where(
          inArray(
            slots.id,
            open.map((s) => s.id),
          ),
        );
      for (const s of open)
        await appendEvent(tx, {
          actor: userId,
          kind: "slot.cancelled",
          subjectType: "slot",
          subjectId: s.id,
          payload: { reason: "account_deactivated" },
        });
    });
  }

  await d.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        status: "deleted",
        email: null,
        phone: null,
        smsOptedOutAt: new Date(),
      })
      .where(eq(users.id, userId));
    await appendEvent(tx, {
      actor: userId,
      kind: "user.deactivated",
      subjectType: "user",
      subjectId: userId,
    });
  });
}
