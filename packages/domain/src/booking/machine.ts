import { performerCancellationFee, venueCancellationFee } from "../cancellation.js";
import type {
  BookingEvent,
  BookingSnapshot,
  BookingState,
  Effect,
} from "./states.js";

export class IllegalTransitionError extends Error {
  readonly code = "illegal_transition";
  constructor(
    readonly state: BookingState,
    readonly event: BookingEvent["kind"],
  ) {
    super(`event ${event} is not legal in state ${state}`);
  }
}

/** A dispute partial-split whose amounts don't conserve the booking total. */
export class InvalidResolutionError extends Error {
  readonly code = "invalid_resolution";
  constructor(message: string) {
    super(message);
  }
}

export interface Decision {
  next: BookingState;
  effects: Effect[];
}

const AUTO_CONFIRM_HOURS = 24;

/**
 * Pure reducer for the booking lifecycle (engineering-spec §5).
 * No I/O. The caller (packages/db transition runner) persists atomically.
 */
export function decide(
  booking: BookingSnapshot,
  event: BookingEvent,
  now: Date,
): Decision {
  const { state, terms } = booking;
  const k = event.kind;

  switch (state) {
    case "offered":
      if (k === "PERFORMER_ACCEPTED")
        return {
          next: "confirming",
          effects: [
            { kind: "cancel_schedule", job: "offer_expiry" },
            { kind: "request_payment" },
          ],
        };
      if (k === "OFFER_EXPIRED")
        return {
          next: "collapsed",
          effects: [
            { kind: "reopen_slot" },
            { kind: "notify", template: "offer_expired", to: "both" },
          ],
        };
      if (k === "VENUE_CANCELLED")
        // withdrawing an unaccepted offer carries no fee
        return {
          next: "collapsed",
          effects: [
            { kind: "cancel_schedule", job: "offer_expiry" },
            { kind: "reopen_slot" },
            { kind: "notify", template: "offer_withdrawn", to: "performer" },
          ],
        };
      break;

    case "confirming":
      if (k === "PAYMENT_SUCCEEDED")
        return {
          next: "confirmed",
          effects: [
            { kind: "schedule", job: "gig_ended", runAt: terms.endsAt },
            { kind: "notify", template: "booking_confirmed", to: "both" },
          ],
        };
      if (k === "PAYMENT_FAILED")
        return {
          next: "collapsed",
          effects: [
            { kind: "reopen_slot" },
            { kind: "notify", template: "payment_failed", to: "both" },
          ],
        };
      break;

    case "confirmed": {
      if (k === "GIG_ENDED")
        return {
          next: "awaiting_confirmation",
          effects: [
            {
              kind: "schedule",
              job: "auto_confirm",
              runAt: new Date(
                new Date(terms.endsAt).getTime() + AUTO_CONFIRM_HOURS * 3_600_000,
              ).toISOString(),
            },
            { kind: "notify", template: "mark_played_prompt", to: "performer" },
          ],
        };
      if (k === "VENUE_CANCELLED") {
        const { feeCents, refundCents } = venueCancellationFee(
          terms.amountCents,
          new Date(terms.startsAt),
          now,
        );
        return {
          next: "cancelled_by_venue",
          effects: [
            { kind: "cancel_schedule", job: "gig_ended" },
            { kind: "cancellation_fee", feeCents, refundCents },
            { kind: "reopen_slot" },
            { kind: "notify", template: "venue_cancelled", to: "performer" },
          ],
        };
      }
      if (k === "PERFORMER_CANCELLED") {
        const { refundCents } = performerCancellationFee(terms.amountCents);
        return {
          next: "cancelled_by_performer",
          effects: [
            { kind: "cancel_schedule", job: "gig_ended" },
            { kind: "refund_funds", amountCents: refundCents },
            { kind: "reliability_strike", against: "performer" },
            { kind: "reopen_slot" },
            { kind: "notify", template: "performer_cancelled", to: "venue" },
          ],
        };
      }
      break;
    }

    case "awaiting_confirmation":
      if (
        k === "PERFORMER_MARKED_PLAYED" ||
        k === "VENUE_CONFIRMED" ||
        k === "AUTO_CONFIRM_ELAPSED"
      ) {
        // PERFORMER_MARKED_PLAYED alone does not release: it records the claim;
        // release happens on venue confirm or the 24h auto-confirm elapsing.
        if (k === "PERFORMER_MARKED_PLAYED")
          return { next: "awaiting_confirmation", effects: [] };
        return {
          next: "released",
          effects: [
            { kind: "cancel_schedule", job: "auto_confirm" },
            { kind: "release_funds", amountCents: terms.amountCents },
            { kind: "notify", template: "payment_released", to: "both" },
          ],
        };
      }
      if (k === "DISPUTE_OPENED")
        return {
          next: "disputed",
          effects: [
            { kind: "cancel_schedule", job: "auto_confirm" },
            { kind: "notify", template: "dispute_opened", to: "both" },
          ],
        };
      break;

    case "disputed":
      if (k === "DISPUTE_RESOLVED") {
        const r = event.resolution;
        if (r.kind === "release_full")
          return {
            next: "released",
            effects: [
              { kind: "release_funds", amountCents: terms.amountCents },
              { kind: "notify", template: "dispute_resolved", to: "both" },
            ],
          };
        if (r.kind === "refund_full")
          return {
            next: "refunded",
            effects: [
              { kind: "refund_funds", amountCents: terms.amountCents },
              { kind: "notify", template: "dispute_resolved", to: "both" },
            ],
          };
        // Money conservation lives in the reducer, not just the API edge: a
        // partial must split EXACTLY the booking total (no value created/lost).
        if (
          !Number.isInteger(r.releaseCents) ||
          !Number.isInteger(r.refundCents) ||
          r.releaseCents < 0 ||
          r.refundCents < 0 ||
          r.releaseCents + r.refundCents !== terms.amountCents
        )
          throw new InvalidResolutionError(
            `partial resolution must split exactly ${terms.amountCents} cents ` +
              `(got release ${r.releaseCents} + refund ${r.refundCents})`,
          );
        return {
          next: "partially_released",
          effects: [
            { kind: "release_funds", amountCents: r.releaseCents },
            { kind: "refund_funds", amountCents: r.refundCents },
            { kind: "notify", template: "dispute_resolved", to: "both" },
          ],
        };
      }
      break;

    // terminal states accept nothing
    case "released":
    case "collapsed":
    case "cancelled_by_venue":
    case "cancelled_by_performer":
    case "refunded":
    case "partially_released":
      break;
  }

  throw new IllegalTransitionError(state, k);
}

/** Effects emitted when an offer is first created (booking row inserted in `offered`). */
export function offerCreatedEffects(offerExpiresAt: string): Effect[] {
  return [
    { kind: "schedule", job: "offer_expiry", runAt: offerExpiresAt },
    { kind: "notify", template: "offer_received", to: "performer" },
  ];
}
