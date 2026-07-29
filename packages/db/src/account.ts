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
import type { Db } from "./client.js";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { cancelSeries } from "./series.js";
import { runSubslotTransition } from "./subslots.js";
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
  techs,
  users,
  techSubslots,
  venues,
} from "./schema.js";

/**
 * Take a person's public presence down (or put it back). Profiles are the
 * public face of an account: a venue publishes a full street address, an act
 * publishes an EPK. When the account stops being active — the person left, or
 * an admin suspended them — those pages and every directory must stop serving
 * them. Shared by deactivation and admin suspend/reinstate so the two can
 * never drift apart.
 */
export async function setProfileVisibility(
  userId: string,
  status: "live" | "hidden",
  tx?: { update: Db["update"] },
): Promise<void> {
  const d = (tx ?? db()) as Db;
  await d.update(performers).set({ status }).where(eq(performers.ownerUserId, userId));
  await d.update(venues).set({ status }).where(eq(venues.ownerUserId, userId));
  await d.update(techs).set({ status }).where(eq(techs.ownerUserId, userId));
}

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

  // A tech who leaves used to have their profile hidden and nothing else: booked
  // sound jobs stayed `booked`, with money charged and nobody told. The performer
  // and venue paths both wind down their commitments; this one didn't, and the
  // incompleteness of the three-way parallelism WAS the bug.
  const [tech] = await d.select().from(techs).where(eq(techs.ownerUserId, userId));
  if (tech) {
    const booked = await d
      .select({ id: techSubslots.id })
      .from(techSubslots)
      .where(and(eq(techSubslots.techId, tech.id), eq(techSubslots.state, "booked")));
    for (const sub of booked) {
      try {
        await runSubslotTransition(sub.id, { kind: "TECH_CANCELLED" }, userId);
      } catch {
        // Already moved on, or lost a race — the wind-down is best-effort, and
        // leaving one behind must not block the rest of the deactivation.
      }
    }
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
    // Unpublish in the same transaction as the account change — otherwise a
    // deactivated venue's street address stays public indefinitely.
    await setProfileVisibility(userId, "hidden", tx);
    await appendEvent(tx, {
      actor: userId,
      kind: "user.deactivated",
      subjectType: "user",
      subjectId: userId,
    });
  });
}
