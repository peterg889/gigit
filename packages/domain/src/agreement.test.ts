import { describe, expect, it } from "vitest";
import { renderAgreement, AGREEMENT_TEMPLATE_VERSION } from "./agreement.js";
import type { BookingTerms } from "./booking/states.js";

const terms: BookingTerms = {
  amountCents: 40000,
  startsAt: "2026-07-01T02:00:00.000Z",
  endsAt: "2026-07-01T04:00:00.000Z",
  setLengthMinutes: 90,
  provides: { pa: true, meal: true },
  notes: "load in at 7",
};

const base = { venueName: "Lakefront Taproom", performerName: "The Bishops", terms };

describe("renderAgreement — discovery-first (payments off, the default)", () => {
  const text = renderAgreement(base); // paymentsEnabled defaults to false

  it("is a plain terms summary, not a performance agreement", () => {
    expect(text).toContain(`BOOKING TERMS (Gigit ${AGREEMENT_TEMPLATE_VERSION})`);
    expect(text).not.toContain("PERFORMANCE AGREEMENT");
  });

  it("says the venue and act settle directly and Gigit holds no money", () => {
    expect(text).toMatch(/settled[\s\S]*directly/);
    expect(text).toContain("does not charge, hold, or pay out");
    expect(text).toContain("not a party to the payment");
  });

  it("makes NO charge / escrow / payout / fee-schedule claims", () => {
    expect(text).not.toContain("charged at confirmation");
    expect(text).not.toContain("held by the platform");
    expect(text).not.toMatch(/50% of the fee/);
    expect(text).not.toMatch(/100% of the fee/);
    expect(text).not.toMatch(/full refund/i);
  });


  it("renders show times in the venue timezone when supplied", () => {
    const localText = renderAgreement({
      ...base,
      timeZone: "America/Chicago",
      venueAddress: "123 Main St, Milwaukee, WI 53202",
    });
    expect(localText).toContain("June 30, 2026");
    expect(localText).toContain("9:00 PM CDT");
    expect(localText).toContain("11:00 PM CDT");
    expect(localText).toContain("Location: 123 Main St, Milwaukee, WI 53202");
    expect(localText).not.toContain("(UTC)");
  });
  it("still carries the deal: parties, pay, times, provided, notes", () => {
    expect(text).toContain("Lakefront Taproom");
    expect(text).toContain("The Bishops");
    expect(text).toContain("$400.00");
    expect(text).toContain("set length 90 minutes");
    expect(text).toContain("house PA system");
    expect(text).toContain("load in at 7");
  });
});

describe("renderAgreement — payments on (the deferred configuration)", () => {
  const text = renderAgreement({ ...base, paymentsEnabled: true });

  it("is the full click-wrap performance agreement", () => {
    expect(text).toContain(`PERFORMANCE AGREEMENT (Gigit template ${AGREEMENT_TEMPLATE_VERSION})`);
    expect(text).toContain("Accepted electronically by both parties");
  });

  it("carries the charge/escrow and the cancellation fee schedule", () => {
    expect(text).toContain("charged at confirmation");
    expect(text).toContain("held by the platform");
    expect(text).toMatch(/50% of the fee/);
    expect(text).toMatch(/100% of the fee/);
  });
});
