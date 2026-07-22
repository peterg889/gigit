import { describe, expect, it } from "vitest";
import {
  decide,
  IllegalTransitionError,
  InvalidResolutionError,
  offerCreatedEffects,
} from "./machine.js";
import {
  BOOKING_EVENTS,
  BOOKING_STATES,
  type BookingEvent,
  type BookingEventKind,
  type BookingSnapshot,
  type BookingState,
} from "./states.js";

const GIG_START = "2026-08-01T19:00:00.000Z";
const GIG_END = "2026-08-01T22:00:00.000Z";

function booking(state: BookingState): BookingSnapshot {
  return {
    id: "bkg_test",
    slotId: "slt_test",
    performerId: "prf_test",
    state,
    version: 1,
    terms: { amountCents: 50_000, startsAt: GIG_START, endsAt: GIG_END },
    offerExpiresAt: "2026-07-20T00:00:00.000Z",
  };
}

function makeEvent(kind: BookingEventKind): BookingEvent {
  switch (kind) {
    case "DISPUTE_OPENED":
      return { kind, openedBy: "venue", reason: "no-show" };
    case "DISPUTE_RESOLVED":
      return { kind, resolution: { kind: "release_full" } };
    case "PAYMENT_FAILED":
      return { kind, reason: "card_declined" };
    default:
      return { kind } as BookingEvent;
  }
}

/**
 * Exhaustive transition table: every state × every event is either an
 * expected transition or an expected rejection. Editing the machine without
 * editing this table fails the build.
 */
const LEGAL: Record<BookingState, Partial<Record<BookingEventKind, BookingState>>> = {
  offered: {
    PERFORMER_ACCEPTED: "confirming",
    PERFORMER_DECLINED: "collapsed",
    OFFER_EXPIRED: "collapsed",
    VENUE_CANCELLED: "collapsed",
  },
  confirming: {
    PAYMENT_SUCCEEDED: "confirmed",
    PAYMENT_FAILED: "collapsed",
  },
  confirmed: {
    GIG_ENDED: "awaiting_confirmation",
    VENUE_CANCELLED: "cancelled_by_venue",
    PERFORMER_CANCELLED: "cancelled_by_performer",
  },
  awaiting_confirmation: {
    PERFORMER_MARKED_PLAYED: "awaiting_confirmation",
    VENUE_CONFIRMED: "released",
    AUTO_CONFIRM_ELAPSED: "released",
    DISPUTE_OPENED: "disputed",
  },
  disputed: {
    DISPUTE_RESOLVED: "released",
  },
  released: {},
  collapsed: {},
  cancelled_by_venue: {},
  cancelled_by_performer: {},
  refunded: {},
  partially_released: {},
};

describe("booking state machine — exhaustive table", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  for (const state of BOOKING_STATES) {
    for (const eventKind of BOOKING_EVENTS) {
      const expected = LEGAL[state][eventKind];
      it(`${state} × ${eventKind} → ${expected ?? "rejected"}`, () => {
        const run = () => decide(booking(state), makeEvent(eventKind), now);
        if (expected) expect(run().next).toBe(expected);
        else expect(run).toThrow(IllegalTransitionError);
      });
    }
  }
});

describe("happy path effects", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("offer creation schedules expiry and notifies the performer", () => {
    const fx = offerCreatedEffects("2026-07-20T00:00:00.000Z");
    expect(fx).toContainEqual({
      kind: "schedule",
      job: "offer_expiry",
      runAt: "2026-07-20T00:00:00.000Z",
    });
  });

  it("acceptance requests payment and cancels the expiry timer", () => {
    const d = decide(booking("offered"), { kind: "PERFORMER_ACCEPTED" }, now);
    expect(d.effects).toContainEqual({ kind: "request_payment" });
    expect(d.effects).toContainEqual({
      kind: "cancel_schedule",
      job: "offer_expiry",
    });
  });

  it("performer decline cancels expiry, reopens the slot, and tells the venue", () => {
    const d = decide(booking("offered"), { kind: "PERFORMER_DECLINED" }, now);
    expect(d.next).toBe("collapsed");
    expect(d.effects).toEqual([
      { kind: "cancel_schedule", job: "offer_expiry" },
      { kind: "reopen_slot" },
      { kind: "notify", template: "offer_declined", to: "venue" },
    ]);
  });

  it("payment success schedules the gig-end timer at gig end", () => {
    const d = decide(booking("confirming"), { kind: "PAYMENT_SUCCEEDED" }, now);
    expect(d.effects).toContainEqual({
      kind: "schedule",
      job: "gig_ended",
      runAt: GIG_END,
    });
  });

  it("gig end schedules auto-confirm 24h after gig end", () => {
    const d = decide(booking("confirmed"), { kind: "GIG_ENDED" }, now);
    const sched = d.effects.find((e) => e.kind === "schedule");
    expect(sched).toEqual({
      kind: "schedule",
      job: "auto_confirm",
      runAt: "2026-08-02T22:00:00.000Z",
    });
  });

  it("auto-confirm releases the full amount", () => {
    const d = decide(
      booking("awaiting_confirmation"),
      { kind: "AUTO_CONFIRM_ELAPSED" },
      now,
    );
    expect(d.effects).toContainEqual({
      kind: "release_funds",
      amountCents: 50_000,
    });
  });

  it("performer marking played does NOT release by itself", () => {
    const d = decide(
      booking("awaiting_confirmation"),
      { kind: "PERFORMER_MARKED_PLAYED" },
      now,
    );
    expect(d.next).toBe("awaiting_confirmation");
    expect(d.effects.filter((e) => e.kind === "release_funds")).toHaveLength(0);
  });
});

describe("cancellation fee windows (venue cancels a $500 gig)", () => {
  const cases: Array<{ at: string; fee: number; label: string }> = [
    { at: "2026-07-10T19:00:00.000Z", fee: 0, label: ">14 days out → 0%" },
    { at: "2026-07-25T19:00:00.000Z", fee: 25_000, label: "7 days out → 50%" },
    // boundary: exactly 48h before start is still in the 50% window
    { at: "2026-07-30T19:00:00.000Z", fee: 25_000, label: "exactly 48h → 50%" },
    { at: "2026-07-31T19:00:01.000Z", fee: 50_000, label: "<48h → 100%" },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const d = decide(
        booking("confirmed"),
        { kind: "VENUE_CANCELLED" },
        new Date(c.at),
      );
      const fee = d.effects.find((e) => e.kind === "cancellation_fee");
      expect(fee).toMatchObject({
        feeCents: c.fee,
        refundCents: 50_000 - c.fee,
      });
      expect(d.effects).toContainEqual({
        kind: "reliability_strike",
        against: "venue",
      });
    });
  }

  it("performer cancellation refunds the venue fully and strikes reliability", () => {
    const d = decide(
      booking("confirmed"),
      { kind: "PERFORMER_CANCELLED" },
      new Date("2026-07-31T19:00:00.000Z"),
    );
    expect(d.effects).toContainEqual({
      kind: "refund_funds",
      amountCents: 50_000,
    });
    expect(d.effects).toContainEqual({
      kind: "reliability_strike",
      against: "performer",
    });
  });
});

describe("dispute resolutions", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  it("partial resolution releases and refunds the stated split", () => {
    const d = decide(
      booking("disputed"),
      {
        kind: "DISPUTE_RESOLVED",
        resolution: { kind: "partial", releaseCents: 30_000, refundCents: 20_000 },
      },
      now,
    );
    expect(d.next).toBe("partially_released");
    expect(d.effects).toContainEqual({ kind: "release_funds", amountCents: 30_000 });
    expect(d.effects).toContainEqual({ kind: "refund_funds", amountCents: 20_000 });
  });
  it("full refund resolution refunds everything", () => {
    const d = decide(
      booking("disputed"),
      { kind: "DISPUTE_RESOLVED", resolution: { kind: "refund_full", fault: "performer" } },
      now,
    );
    expect(d.next).toBe("refunded");
    expect(d.effects).toContainEqual({ kind: "refund_funds", amountCents: 50_000 });
    expect(d.effects).toContainEqual({
      kind: "reliability_strike",
      against: "performer",
    });
  });
  it("rejects a partial split that doesn't conserve the booking total (would mint ledger value)", () => {
    expect(() =>
      decide(
        booking("disputed"),
        {
          kind: "DISPUTE_RESOLVED",
          resolution: { kind: "partial", releaseCents: 40_000, refundCents: 40_000 },
        },
        now,
      ),
    ).toThrow(InvalidResolutionError);
  });
  it("rejects a partial split with a negative leg", () => {
    expect(() =>
      decide(
        booking("disputed"),
        {
          kind: "DISPUTE_RESOLVED",
          resolution: { kind: "partial", releaseCents: 60_000, refundCents: -10_000 },
        },
        now,
      ),
    ).toThrow(InvalidResolutionError);
  });
  it.each([
    [0, 50_000],
    [50_000, 0],
  ])(
    "rejects a partial split with a zero leg (%i release / %i refund)",
    (releaseCents, refundCents) => {
      expect(() =>
        decide(
          booking("disputed"),
          {
            kind: "DISPUTE_RESOLVED",
            resolution: { kind: "partial", releaseCents, refundCents },
          },
          now,
        ),
      ).toThrow(InvalidResolutionError);
    },
  );

  it("rejects a partial split with a non-integer leg (even when it sums to the total)", () => {
    expect(() =>
      decide(
        booking("disputed"),
        {
          kind: "DISPUTE_RESOLVED",
          resolution: { kind: "partial", releaseCents: 25_000.5, refundCents: 24_999.5 },
        },
        now,
      ),
    ).toThrow(InvalidResolutionError);
  });
});
