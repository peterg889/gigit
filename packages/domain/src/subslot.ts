/**
 * Tech sub-slot state machine (PRD F6.2/F6.3). Shares the cancellation fee
 * schedule and effect vocabulary with the booking machine, but is its own
 * small reducer: a tech applies TO a posted budget, so applying is agreeing —
 * there is no offer/negotiation phase. The payer's selection confirms.
 *
 * Money intents (ledger entries) are decided here and persisted by the
 * runner; the parent booking's release/cancellation cascades in via
 * PARENT_RELEASED / PARENT_CANCELLED (worker fan-out).
 */
import { venueCancellationFee } from "./cancellation.js";

export const SUBSLOT_STATES = [
  "awaiting_payer",
  "open",
  "booked",
  "released",
  "cancelled_by_payer",
  "cancelled_with_parent",
  "declined_by_payer",
  "withdrawn_by_proposer",
] as const;
export type SubslotState = (typeof SUBSLOT_STATES)[number];

/**
 * States that represent the one live sound-selection round on a booking.
 *
 * `awaiting_payer` belongs here even though no tech can see it yet: it already
 * holds the booking's single sound slot. Leaving it out would let a booking
 * carry a proposal AND a live job at the same time, and would put
 * createTechSubslot's guard at odds with `tech_subslots_active_booking_uq`,
 * whose predicate is generated from this list.
 */
export const ACTIVE_SUBSLOT_STATES: readonly SubslotState[] = [
  "awaiting_payer",
  "open",
  "booked",
];

export const SUBSLOT_EVENTS = [
  "PAYER_ACCEPTED",
  "PAYER_DECLINED",
  "PROPOSAL_WITHDRAWN",
  "TECH_BOOKED",
  "PARENT_RELEASED",
  "PARENT_CANCELLED",
  "PAYER_CANCELLED",
  "TECH_CANCELLED",
] as const;

export type SubslotEvent =
  | { kind: "PAYER_ACCEPTED" }
  | { kind: "PAYER_DECLINED" }
  | { kind: "PROPOSAL_WITHDRAWN" }
  | { kind: "TECH_BOOKED"; techId: string }
  | { kind: "PARENT_RELEASED" }
  | { kind: "PARENT_CANCELLED" }
  | { kind: "PAYER_CANCELLED" }
  | { kind: "TECH_CANCELLED" };

export type SubslotEffect =
  | { kind: "subslot_charge"; amountCents: number }
  | { kind: "subslot_release"; amountCents: number }
  | { kind: "subslot_fee"; feeCents: number; refundCents: number }
  | { kind: "subslot_refund"; amountCents: number }
  | { kind: "subslot_reliability_strike"; against: "tech" }
  | {
      kind: "notify";
      template: string;
      // "proposer" is the booking party that is NOT the payer — the only side
      // that can put a job into `awaiting_payer`, so it needs no column of its
      // own. Without this target a decline is silent and the side that asked
      // for a tech waits forever on an answer that already came.
      to: "payer" | "tech" | "both" | "proposer";
    };

export interface SubslotSnapshot {
  state: SubslotState;
  budgetCents: number;
  gigStartsAt: Date;
  techId: string | null;
}

export class IllegalSubslotTransitionError extends Error {
  constructor(state: SubslotState, event: string) {
    super(`illegal sub-slot transition: ${event} in ${state}`);
  }
}

export function decideSubslot(
  s: SubslotSnapshot,
  event: SubslotEvent,
  now: Date,
): { next: SubslotState; effects: SubslotEffect[]; techId?: string | null } {
  switch (s.state) {
    // A sound job names who pays for it, and until this state existed the
    // named payer never had to agree: an act could post a job with
    // payer:"venue" and the venue learned it owed a tech from the listing.
    // A job posted by anyone other than its payer starts here and reaches no
    // tech until the payer says yes; posted BY the payer, posting is consent
    // and it starts `open`.
    case "awaiting_payer":
      switch (event.kind) {
        case "PAYER_ACCEPTED":
          return {
            next: "open",
            effects: [
              { kind: "notify", template: "subslot_proposal_accepted", to: "proposer" },
            ],
          };
        case "PAYER_DECLINED":
          // Terminal, and deliberately NOT cancelled_by_payer: that state means
          // the payer closed a job it had agreed to fund (and, from `booked`,
          // owes the tech a fee for). This one means no obligation was ever
          // created. Collapsing the two would read back as the payer breaking
          // a commitment it never made.
          return {
            next: "declined_by_payer",
            effects: [
              { kind: "notify", template: "subslot_proposal_declined", to: "proposer" },
            ],
          };
        case "PROPOSAL_WITHDRAWN":
          // The proposer taking its own ask back. The payer was asked to act,
          // so it has to hear that it no longer needs to.
          return {
            next: "withdrawn_by_proposer",
            effects: [
              { kind: "notify", template: "subslot_proposal_withdrawn", to: "payer" },
            ],
          };
        case "PARENT_CANCELLED":
        case "PARENT_RELEASED":
          // The parent's own outcome closes an unanswered proposal, whichever
          // way it went: nothing was charged, nothing was promised, and both
          // parties already get the parent booking's own notice. PARENT_RELEASED
          // lands here rather than in `released` because no tech was ever
          // booked and there is nothing to release — and routing it to the same
          // terminal state as PARENT_CANCELLED is what lets the worker's cascade
          // keep its existing "booked → PARENT_RELEASED" branch unchanged.
          return { next: "cancelled_with_parent", effects: [] };
        default:
          throw new IllegalSubslotTransitionError(s.state, event.kind);
      }
    case "open":
      switch (event.kind) {
        case "TECH_BOOKED":
          return {
            next: "booked",
            techId: event.techId,
            effects: [
              { kind: "subslot_charge", amountCents: s.budgetCents },
              { kind: "notify", template: "subslot_booked", to: "both" },
            ],
          };
        case "PARENT_CANCELLED":
          // nothing charged yet — close quietly
          return {
            next: "cancelled_with_parent",
            effects: [{ kind: "notify", template: "subslot_cancelled", to: "payer" }],
          };
        case "PAYER_CANCELLED":
          return { next: "cancelled_by_payer", effects: [] };
        default:
          throw new IllegalSubslotTransitionError(s.state, event.kind);
      }
    case "booked":
      switch (event.kind) {
        case "PARENT_RELEASED":
          return {
            next: "released",
            effects: [
              { kind: "subslot_release", amountCents: s.budgetCents },
              { kind: "notify", template: "payment_released", to: "tech" },
            ],
          };
        case "PARENT_CANCELLED":
        case "PAYER_CANCELLED": {
          // tech is protected by the same schedule as the act (spec §5)
          const fee = venueCancellationFee(s.budgetCents, s.gigStartsAt, now);
          return {
            next:
              event.kind === "PARENT_CANCELLED"
                ? "cancelled_with_parent"
                : "cancelled_by_payer",
            effects: [
              {
                kind: "subslot_fee",
                feeCents: fee.feeCents,
                refundCents: fee.refundCents,
              },
              { kind: "notify", template: "subslot_cancelled", to: "tech" },
            ],
          };
        }
        case "TECH_CANCELLED":
          // full refund to the payer; the sub-slot reopens for another tech
          return {
            next: "open",
            techId: null,
            effects: [
              { kind: "subslot_refund", amountCents: s.budgetCents },
              { kind: "subslot_reliability_strike", against: "tech" },
              { kind: "notify", template: "subslot_tech_cancelled", to: "payer" },
            ],
          };
        default:
          throw new IllegalSubslotTransitionError(s.state, event.kind);
      }
    default:
      throw new IllegalSubslotTransitionError(s.state, event.kind);
  }
}
