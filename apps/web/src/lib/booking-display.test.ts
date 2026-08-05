import { describe, expect, it } from "vitest";
import {
  bookingContactsAreVisible,
  confirmedCancellationCopy,
} from "./booking-display";

describe("booking contact visibility", () => {
  it("keeps contact details hidden while an offer is still only a proposal", () => {
    expect(bookingContactsAreVisible("offered")).toBe(false);
    expect(bookingContactsAreVisible("confirming")).toBe(false);
    expect(bookingContactsAreVisible("collapsed")).toBe(false);
  });

  it("keeps already-revealed details available through post-confirmation states", () => {
    for (const state of [
      "confirmed",
      "awaiting_confirmation",
      "disputed",
      "released",
      "refunded",
      "partially_released",
    ] as const) {
      expect(bookingContactsAreVisible(state)).toBe(true);
    }
  });

  it("does not reveal contacts when an unconfirmed offer is cancelled", () => {
    expect(bookingContactsAreVisible("cancelled_by_venue", false)).toBe(false);
    expect(bookingContactsAreVisible("cancelled_by_performer", false)).toBe(false);
  });

  it("keeps contacts visible when cancellation follows confirmation", () => {
    expect(bookingContactsAreVisible("cancelled_by_venue", true)).toBe(true);
    expect(bookingContactsAreVisible("cancelled_by_performer", true)).toBe(true);
  });
});

describe("confirmed booking cancellation copy", () => {
  const now = new Date("2030-04-01T20:00:00.000Z");
  const future = "2030-04-01T20:00:00.001Z";

  it("says a future date reopens and preserves each side's consequence", () => {
    const venue = confirmedCancellationCopy(
      { role: "venue", paymentsEnabled: true, startsAt: future },
      now,
    );
    expect(venue.dateReopens).toBe(true);
    expect(venue.confirm).toContain("date reopens");
    expect(venue.consequence).toContain("owe more of the fee");

    const performer = confirmedCancellationCopy(
      { role: "performer", paymentsEnabled: false, startsAt: future },
      now,
    );
    expect(performer.confirm).toContain("counts against your reliability");
  });

  it("never promises reopening at or after downbeat", () => {
    for (const startsAt of [
      "2030-04-01T20:00:00.000Z",
      "2030-04-01T19:59:59.999Z",
      "not-a-date",
    ]) {
      for (const role of ["venue", "performer"] as const) {
        const copy = confirmedCancellationCopy(
          { role, paymentsEnabled: true, startsAt },
          now,
        );
        expect(copy.dateReopens).toBe(false);
        expect(copy.confirm).toContain("will not reopen");
        expect(copy.consequence).toContain("will not reopen");
        expect(copy.confirm).not.toMatch(/date reopens(?:\.| for)/i);
        expect(copy.consequence).not.toMatch(/^Reopens the date/i);
      }
    }
  });
});
