import { describe, expect, it } from "vitest";
import {
  IllegalSubslotTransitionError,
  SUBSLOT_EVENTS,
  SUBSLOT_STATES,
  decideSubslot,
  type SubslotEvent,
  type SubslotSnapshot,
  type SubslotState,
} from "./subslot.js";

const gig = new Date("2026-07-10T20:00:00Z");
const snap = (state: SubslotSnapshot["state"], techId: string | null = null): SubslotSnapshot => ({
  state,
  budgetCents: 25000,
  gigStartsAt: gig,
  techId,
});

describe("tech sub-slot machine", () => {
  it("open + TECH_BOOKED → booked, charges the payer", () => {
    const r = decideSubslot(snap("open"), { kind: "TECH_BOOKED", techId: "tec_1" }, new Date());
    expect(r.next).toBe("booked");
    expect(r.techId).toBe("tec_1");
    expect(r.effects).toContainEqual({ kind: "subslot_charge", amountCents: 25000 });
  });

  it("booked + PARENT_RELEASED → released, full amount to tech", () => {
    const r = decideSubslot(snap("booked", "tec_1"), { kind: "PARENT_RELEASED" }, new Date());
    expect(r.next).toBe("released");
    expect(r.effects).toContainEqual({ kind: "subslot_release", amountCents: 25000 });
  });

  it("booked + PARENT_CANCELLED inside 48h → 100% to tech", () => {
    const now = new Date("2026-07-09T20:00:00Z"); // 24h out
    const r = decideSubslot(snap("booked", "tec_1"), { kind: "PARENT_CANCELLED" }, now);
    expect(r.next).toBe("cancelled_with_parent");
    expect(r.effects).toContainEqual({
      kind: "subslot_fee",
      feeCents: 25000,
      refundCents: 0,
    });
  });

  it("booked + PAYER_CANCELLED in 48h–14d window → 50/50", () => {
    const now = new Date("2026-07-05T20:00:00Z"); // 5 days out
    const r = decideSubslot(snap("booked", "tec_1"), { kind: "PAYER_CANCELLED" }, now);
    expect(r.next).toBe("cancelled_by_payer");
    expect(r.effects).toContainEqual({
      kind: "subslot_fee",
      feeCents: 12500,
      refundCents: 12500,
    });
  });

  it("booked + TECH_CANCELLED → reopens with full refund", () => {
    const r = decideSubslot(snap("booked", "tec_1"), { kind: "TECH_CANCELLED" }, new Date());
    expect(r.next).toBe("open");
    expect(r.techId).toBeNull();
    expect(r.effects).toContainEqual({ kind: "subslot_refund", amountCents: 25000 });
    expect(r.effects).toContainEqual({
      kind: "subslot_reliability_strike",
      against: "tech",
    });
  });

  it("open + PARENT_CANCELLED closes quietly (nothing charged)", () => {
    const r = decideSubslot(snap("open"), { kind: "PARENT_CANCELLED" }, new Date());
    expect(r.next).toBe("cancelled_with_parent");
    expect(r.effects.some((e) => e.kind.startsWith("subslot_"))).toBe(false);
  });

  it("awaiting_payer + PAYER_ACCEPTED → open, and only then can a tech see it", () => {
    const r = decideSubslot(snap("awaiting_payer"), { kind: "PAYER_ACCEPTED" }, new Date());
    expect(r.next).toBe("open");
    // Consent creates no obligation by itself — the charge still waits for a
    // tech to actually be booked.
    expect(r.effects.some((e) => e.kind === "subslot_charge")).toBe(false);
    expect(r.effects).toContainEqual({
      kind: "notify",
      template: "subslot_proposal_accepted",
      to: "proposer",
    });
  });

  it("awaiting_payer + PAYER_DECLINED is terminal and is NOT a payer cancellation", () => {
    const r = decideSubslot(snap("awaiting_payer"), { kind: "PAYER_DECLINED" }, new Date());
    // The distinction is the whole point: cancelled_by_payer means the payer
    // walked away from a job it had agreed to fund. Declining means it never
    // agreed, so no fee schedule and no money effect can apply.
    expect(r.next).toBe("declined_by_payer");
    expect(r.next).not.toBe("cancelled_by_payer");
    expect(r.effects.some((e) => e.kind.startsWith("subslot_"))).toBe(false);
    expect(r.effects).toContainEqual({
      kind: "notify",
      template: "subslot_proposal_declined",
      to: "proposer",
    });
    // Terminal: a declined proposal cannot be revived into a live job.
    for (const ev of SUBSLOT_EVENTS)
      expect(() =>
        decideSubslot(
          snap("declined_by_payer"),
          (ev === "TECH_BOOKED"
            ? { kind: ev, techId: "tec_x" }
            : { kind: ev }) as SubslotEvent,
          new Date(),
        ),
      ).toThrow(IllegalSubslotTransitionError);
  });

  it("awaiting_payer + PROPOSAL_WITHDRAWN is terminal and tells the payer to stop", () => {
    const r = decideSubslot(
      snap("awaiting_payer"),
      { kind: "PROPOSAL_WITHDRAWN" },
      new Date(),
    );
    expect(r.next).toBe("withdrawn_by_proposer");
    expect(r.effects).toContainEqual({
      kind: "notify",
      template: "subslot_proposal_withdrawn",
      to: "payer",
    });
    for (const ev of SUBSLOT_EVENTS)
      expect(() =>
        decideSubslot(
          snap("withdrawn_by_proposer"),
          (ev === "TECH_BOOKED"
            ? { kind: ev, techId: "tec_x" }
            : { kind: ev }) as SubslotEvent,
          new Date(),
        ),
      ).toThrow(IllegalSubslotTransitionError);
  });

  it("never books or charges from a proposal the payer has not accepted", () => {
    // The gate is worthless if the reducer will still take a booking straight
    // out of `awaiting_payer` — that would charge a party that never agreed.
    expect(() =>
      decideSubslot(
        snap("awaiting_payer"),
        { kind: "TECH_BOOKED", techId: "tec_1" },
        new Date(),
      ),
    ).toThrow(IllegalSubslotTransitionError);
    // And the payer's live-job cancellation is not a back door to the same
    // terminal state a decline uses.
    expect(() =>
      decideSubslot(snap("awaiting_payer"), { kind: "PAYER_CANCELLED" }, new Date()),
    ).toThrow(IllegalSubslotTransitionError);
  });

  it("closes an unanswered proposal with its parent, either outcome, quietly", () => {
    // Both cascade branches must land somewhere legal: `awaiting_payer` is an
    // ACTIVE state, so the worker's parent fan-out WILL reach it, and an
    // illegal-transition throw there dead-letters the parent's own cascade.
    for (const kind of ["PARENT_CANCELLED", "PARENT_RELEASED"] as const) {
      const r = decideSubslot(snap("awaiting_payer"), { kind }, new Date());
      expect(r.next).toBe("cancelled_with_parent");
      expect(r.effects).toEqual([]);
    }
  });

  it("rejects illegal transitions", () => {
    expect(() =>
      decideSubslot(snap("released"), { kind: "PARENT_RELEASED" }, new Date()),
    ).toThrow(IllegalSubslotTransitionError);
    expect(() =>
      decideSubslot(snap("open"), { kind: "PARENT_RELEASED" }, new Date()),
    ).toThrow(IllegalSubslotTransitionError);
  });
});

// Every state×event pair either transitions to a known state or throws — no
// crash, no undefined, no dead 'cancelled_by_tech' state (which is gone).
const LEGAL: Record<SubslotState, Partial<Record<(typeof SUBSLOT_EVENTS)[number], SubslotState>>> = {
  awaiting_payer: {
    PAYER_ACCEPTED: "open",
    PAYER_DECLINED: "declined_by_payer",
    PROPOSAL_WITHDRAWN: "withdrawn_by_proposer",
    PARENT_CANCELLED: "cancelled_with_parent",
    PARENT_RELEASED: "cancelled_with_parent",
  },
  open: {
    TECH_BOOKED: "booked",
    PARENT_CANCELLED: "cancelled_with_parent",
    PAYER_CANCELLED: "cancelled_by_payer",
  },
  booked: {
    PARENT_RELEASED: "released",
    PARENT_CANCELLED: "cancelled_with_parent",
    PAYER_CANCELLED: "cancelled_by_payer",
    TECH_CANCELLED: "open",
  },
  released: {},
  cancelled_by_payer: {},
  cancelled_with_parent: {},
  declined_by_payer: {},
  withdrawn_by_proposer: {},
};

describe("tech sub-slot machine — exhaustive state×event table", () => {
  for (const state of SUBSLOT_STATES) {
    for (const ev of SUBSLOT_EVENTS) {
      const expected = LEGAL[state][ev];
      const event = (ev === "TECH_BOOKED"
        ? { kind: ev, techId: "tec_x" }
        : { kind: ev }) as SubslotEvent;
      it(`${state} + ${ev} → ${expected ?? "illegal"}`, () => {
        if (expected) {
          expect(decideSubslot(snap(state, "tec_1"), event, gig).next).toBe(expected);
        } else {
          expect(() => decideSubslot(snap(state, "tec_1"), event, gig)).toThrow(
            IllegalSubslotTransitionError,
          );
        }
      });
    }
  }
});
