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
