/**
 * Property/model-based tests (engineering-spec §13): drive random event
 * sequences through the reducer and assert the invariants hold on EVERY path,
 * not just the enumerated ones.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BOOKING_STATES,
  TERMINAL_STATES,
  type BookingEvent,
  type BookingState,
} from "./states.js";

const ALL_STATES: ReadonlySet<string> = new Set(BOOKING_STATES);
import { IllegalTransitionError, decide } from "./machine.js";

const AMOUNT = 50_000;
const GIG_START = new Date("2026-07-10T20:00:00Z");
const GIG_END = new Date("2026-07-10T22:00:00Z");

const EVENTS: BookingEvent[] = [
  { kind: "PERFORMER_ACCEPTED" },
  { kind: "PERFORMER_DECLINED" },
  { kind: "PAYMENT_SUCCEEDED" },
  { kind: "PAYMENT_FAILED", reason: "card_declined" },
  { kind: "OFFER_EXPIRED" },
  { kind: "GIG_ENDED" },
  { kind: "PERFORMER_MARKED_PLAYED" },
  { kind: "VENUE_CONFIRMED" },
  { kind: "AUTO_CONFIRM_ELAPSED" },
  { kind: "DISPUTE_OPENED", openedBy: "venue", reason: "no show" },
  {
    kind: "DISPUTE_RESOLVED",
    resolution: { kind: "partial", releaseCents: 20_000, refundCents: 30_000 },
  },
  { kind: "VENUE_CANCELLED" },
  { kind: "PERFORMER_CANCELLED" },
];

const snapshot = (state: BookingState) => ({
  state,
  version: 1,
  terms: {
    amountCents: AMOUNT,
    startsAt: GIG_START.toISOString(),
    endsAt: GIG_END.toISOString(),
  },
  offerExpiresAt: new Date("2026-07-01T00:00:00Z"),
});

const arbEventIndices = fc.array(fc.nat(EVENTS.length - 1), {
  minLength: 1,
  maxLength: 20,
});
const arbClock = fc.integer({ min: -30, max: 2 }).map(
  // a clock anywhere from 30 days before the gig to 2 days after
  (d) => new Date(GIG_START.getTime() + d * 86_400_000),
);

describe("booking machine properties (random event sequences)", () => {
  it("never produces a state outside the enumerated set; terminal states never move", () => {
    fc.assert(
      fc.property(arbEventIndices, arbClock, (indices, clock) => {
        let state: BookingState = "offered";
        for (const i of indices) {
          try {
            const d = decide(snapshot(state), EVENTS[i]!, clock);
            expect(ALL_STATES.has(d.next)).toBe(true);
            expect(TERMINAL_STATES.has(state)).toBe(false); // moved ⇒ wasn't terminal
            state = d.next;
          } catch (err) {
            expect(err).toBeInstanceOf(IllegalTransitionError);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("money conservation: every reachable money effect set sums to exactly the booking amount", () => {
    fc.assert(
      fc.property(arbEventIndices, arbClock, (indices, clock) => {
        let state: BookingState = "offered";
        let released = 0;
        let refunded = 0;
        for (const i of indices) {
          try {
            const d = decide(snapshot(state), EVENTS[i]!, clock);
            for (const fx of d.effects) {
              if (fx.kind === "release_funds") released += fx.amountCents;
              else if (fx.kind === "refund_funds") refunded += fx.amountCents;
              else if (fx.kind === "cancellation_fee") {
                released += fx.feeCents;
                refunded += fx.refundCents;
                // the fee split itself always conserves the amount
                expect(fx.feeCents + fx.refundCents).toBe(AMOUNT);
              }
            }
            state = d.next;
          } catch (err) {
            expect(err).toBeInstanceOf(IllegalTransitionError);
          }
        }
        // at most one settlement ever happens, and it conserves the amount
        expect(released + refunded === 0 || released + refunded === AMOUNT).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("a charge is requested at most once per booking lifetime", () => {
    fc.assert(
      fc.property(arbEventIndices, arbClock, (indices, clock) => {
        let state: BookingState = "offered";
        let charges = 0;
        for (const i of indices) {
          try {
            const d = decide(snapshot(state), EVENTS[i]!, clock);
            charges += d.effects.filter((e) => e.kind === "request_payment").length;
            state = d.next;
          } catch {
            /* illegal — fine */
          }
        }
        // payment failure reopens the slot; a NEW booking takes over from there,
        // so within one booking the charge request fires at most once.
        expect(charges).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });
});
