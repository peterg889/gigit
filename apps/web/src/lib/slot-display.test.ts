import { describe, expect, it } from "vitest";
import {
  declinedApplicationMessage,
  effectiveSlotStatus,
} from "./slot-display";

describe("effectiveSlotStatus", () => {
  const now = new Date("2026-07-30T12:00:00Z");

  it("renders a stale open slot as expired at and after downbeat", () => {
    expect(
      effectiveSlotStatus("open", new Date("2026-07-30T12:00:00Z"), now),
    ).toBe("expired");
    expect(
      effectiveSlotStatus("open", new Date("2026-07-30T11:59:59Z"), now),
    ).toBe("expired");
  });

  it("keeps future open slots actionable", () => {
    expect(
      effectiveSlotStatus("open", new Date("2026-07-30T12:00:01Z"), now),
    ).toBe("open");
  });

  it("does not rewrite persisted non-open statuses", () => {
    expect(
      effectiveSlotStatus("filled", new Date("2026-07-29T12:00:00Z"), now),
    ).toBe("filled");
  });

  it("explains each persisted decline reason without inventing a booking", () => {
    expect(declinedApplicationMessage("venue_declined")).toContain(
      "decided not to move forward",
    );
    expect(declinedApplicationMessage("venue_declined")).not.toContain(
      "another act",
    );
    expect(declinedApplicationMessage("slot_filled")).toContain(
      "booked another act",
    );
    expect(declinedApplicationMessage("slot_cancelled")).toContain(
      "cancelled this date",
    );
    expect(declinedApplicationMessage("slot_expired")).toContain(
      "passed without a booking",
    );
  });
});
