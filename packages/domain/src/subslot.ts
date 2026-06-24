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
  "open",
  "booked",
  "released",
  "cancelled_by_payer",
  "cancelled_with_parent",
] as const;
export type SubslotState = (typeof SUBSLOT_STATES)[number];

export const SUBSLOT_EVENTS = [
  "TECH_BOOKED",
  "PARENT_RELEASED",
  "PARENT_CANCELLED",
  "PAYER_CANCELLED",
  "TECH_CANCELLED",
] as const;

export const SUBSLOT_TERMINAL = new Set<SubslotState>([
  "released",
  "cancelled_by_payer",
  "cancelled_with_parent",
]);

export type SubslotEvent =
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
  | { kind: "notify"; template: string; to: "payer" | "tech" | "both" };

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
