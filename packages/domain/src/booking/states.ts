/**
 * Booking lifecycle. The FULL state set ships in M0 (engineering-spec §5);
 * M0 simply uses a NullPaymentGateway so confirming → confirmed is immediate.
 */
export const BOOKING_STATES = [
  "offered",
  "confirming",
  "confirmed",
  "awaiting_confirmation",
  "released",
  "collapsed",
  "disputed",
  "cancelled_by_venue",
  "cancelled_by_performer",
  "refunded",
  "partially_released",
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<BookingState> = new Set([
  "released",
  "collapsed",
  "cancelled_by_performer",
  "refunded",
  "partially_released",
  // cancelled_by_venue is terminal too; listed separately in docs because money still moves (fee payout)
  "cancelled_by_venue",
]);

/**
 * Sets that LOOK like TERMINAL_STATES and are not. Each is a distinct question,
 * so they're named rather than merged — four hardcoded lists that partly overlap
 * is an invitation to "consolidate" them into a bug.
 */

/**
 * A booking that occupies the performer's calendar, for the double-book guard.
 * `offered` is deliberately absent — an unaccepted offer doesn't block anything —
 * and so is every terminal state, including `released`: a gig that already
 * happened can't collide with a future one.
 */
export const ACTIVE_BOOKING_STATES: readonly BookingState[] = [
  "confirming",
  "confirmed",
  "awaiting_confirmation",
  "disputed",
];

/**
 * A booking that owns its advertised date under `bookings_active_slot_uq`.
 *
 * This is deliberately broader than ACTIVE_BOOKING_STATES: a firm `offered`
 * hold excludes another offer, and a released/partially-released gig has spent
 * its historical date even though it no longer occupies the performer's future
 * calendar. Keep the DB partial-index predicate aligned with this exact set;
 * packages/db/src/migrations.test.ts pins that cross-layer invariant.
 */
export const SLOT_HOLDING_BOOKING_STATES: readonly BookingState[] = [
  "offered",
  "confirming",
  "confirmed",
  "awaiting_confirmation",
  "disputed",
  "released",
  "partially_released",
];

/**
 * The booking died, so the slot is genuinely free again. Note `released` and
 * `partially_released` are NOT here: the night happened, so the slot is spent
 * even though the booking is terminal. This is what series re-book asks.
 */
export const FELL_THROUGH_STATES: readonly BookingState[] = [
  "collapsed",
  "cancelled_by_venue",
  "cancelled_by_performer",
  "refunded",
];

/**
 * Terminal states where money actually moved, i.e. the scope of the ledger
 * balance check. `collapsed` is absent because it never charged — including it
 * would flag every abandoned offer as an imbalance.
 */
export const MONEY_SETTLED_STATES: readonly BookingState[] = [
  "released",
  "refunded",
  "partially_released",
  "cancelled_by_venue",
  "cancelled_by_performer",
];

export const BOOKING_EVENTS = [
  "PERFORMER_ACCEPTED",
  "PERFORMER_DECLINED",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "OFFER_EXPIRED",
  "GIG_ENDED",
  "PERFORMER_MARKED_PLAYED",
  "VENUE_CONFIRMED",
  "AUTO_CONFIRM_ELAPSED",
  "DISPUTE_OPENED",
  "DISPUTE_RESOLVED",
  "VENUE_CANCELLED",
  "PERFORMER_CANCELLED",
] as const;
export type BookingEventKind = (typeof BOOKING_EVENTS)[number];

export interface BookingTerms {
  amountCents: number;
  /** gig start/end, ISO-8601 UTC */
  startsAt: string;
  endsAt: string;
  setLengthMinutes?: number;
  provides?: { pa?: boolean; meal?: boolean; parking?: boolean };
  notes?: string;
  /** Venue location snapshot locked when the firm offer is created. */
  venueAddress?: string;
  timeZone?: string;
}

export interface BookingSnapshot {
  id: string;
  slotId: string;
  performerId: string;
  state: BookingState;
  version: number;
  terms: BookingTerms;
  /** set when the offer was created; offers expire if unaccepted */
  offerExpiresAt: string;
}

export type DisputeResolution =
  | { kind: "release_full"; fault?: "venue" | "performer" | "neither" }
  | { kind: "refund_full"; fault?: "venue" | "performer" | "neither" }
  | {
      kind: "partial";
      releaseCents: number;
      refundCents: number;
      fault?: "venue" | "performer" | "neither";
    };
export type BookingEvent =
  | { kind: "PERFORMER_ACCEPTED" }
  | { kind: "PERFORMER_DECLINED" }
  | { kind: "PAYMENT_SUCCEEDED"; paymentRef?: string }
  | { kind: "PAYMENT_FAILED"; reason?: string }
  | { kind: "OFFER_EXPIRED" }
  | { kind: "GIG_ENDED" }
  | { kind: "PERFORMER_MARKED_PLAYED" }
  | { kind: "VENUE_CONFIRMED" }
  | { kind: "AUTO_CONFIRM_ELAPSED" }
  | { kind: "DISPUTE_OPENED"; openedBy: "venue" | "performer"; reason: string }
  | { kind: "DISPUTE_RESOLVED"; resolution: DisputeResolution }
  | { kind: "VENUE_CANCELLED" }
  | { kind: "PERFORMER_CANCELLED" };

/** Side effects are data; the db layer records them, the worker interprets them. */
export type Effect =
  | { kind: "request_payment" } // M0: NullPaymentGateway feeds back PAYMENT_SUCCEEDED
  | { kind: "schedule"; job: "offer_expiry" | "gig_ended" | "auto_confirm"; runAt: string }
  | { kind: "cancel_schedule"; job: "offer_expiry" | "gig_ended" | "auto_confirm" }
  | {
      kind: "release_funds";
      amountCents: number;
      /**
       * Distinguishes an intentional, replay-safe money operation from every
       * other transfer of the same amount on this booking. Lifecycle effects
       * omit it and retain their established booking + amount gateway key.
       */
      operationKey?: string;
    }
  | {
      kind: "refund_funds";
      amountCents: number;
      /** See release_funds.operationKey. */
      operationKey?: string;
    }
  | { kind: "cancellation_fee"; feeCents: number; refundCents: number }
  | { kind: "reopen_slot" }
  | { kind: "notify"; template: string; to: "venue" | "performer" | "both" }
  | { kind: "reliability_strike"; against: "venue" | "performer" };
