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
  | { kind: "PAYMENT_SUCCEEDED" }
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
  | { kind: "release_funds"; amountCents: number }
  | { kind: "refund_funds"; amountCents: number }
  | { kind: "cancellation_fee"; feeCents: number; refundCents: number }
  | { kind: "reopen_slot" }
  | { kind: "notify"; template: string; to: "venue" | "performer" | "both" }
  | { kind: "reliability_strike"; against: "venue" | "performer" };
