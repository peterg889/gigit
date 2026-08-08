import { describe, expect, it } from "vitest";
import {
  equipmentCount,
  houseOperatorLabel,
  isSoundApplicantBookable,
  isSoundJobActionable,
  isPayerSoundCancellationActionable,
  isSoundParentActionable,
  isTechSoundCancellationActionable,
  payerSoundCancellationConfirmation,
  soundApplicationMessage,
  soundAssignmentMessage,
} from "./sound-display";

describe("sound fact display", () => {
  it("distinguishes an unknown count from a listed zero", () => {
    expect(equipmentCount(undefined, "microphone")).toBe(
      "microphone count not listed",
    );
    expect(equipmentCount(0, "microphone")).toBe("0 microphones");
    expect(equipmentCount(1, "monitor")).toBe("1 monitor");
  });

  it("keeps an unanswered operator question distinct from no", () => {
    expect(houseOperatorLabel(undefined)).toBe(
      "house sound tech not confirmed",
    );
    expect(houseOperatorLabel(false)).toBe("no house sound tech");
    expect(houseOperatorLabel(true)).toBe("house sound tech included");
  });

  it("only treats a future open job on a confirmed, active gig as actionable", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const live = {
      subslotState: "open",
      bookingState: "confirmed",
      startsAt: "2030-01-02T00:00:00.000Z",
      venueProfileStatus: "live",
      performerProfileStatus: "live",
      venueOwnerStatus: "active",
      performerOwnerStatus: "active",
    };
    expect(isSoundJobActionable(live, now)).toBe(true);
    expect(isSoundParentActionable(live, now)).toBe(true);
    expect(
      isTechSoundCancellationActionable(
        { ...live, subslotState: "booked" },
        now,
      ),
    ).toBe(true);
    expect(
      isSoundJobActionable({ ...live, bookingState: "cancelled_by_venue" }, now),
    ).toBe(false);
    expect(
      isSoundJobActionable({ ...live, startsAt: "2029-12-31T23:59:59.000Z" }, now),
    ).toBe(false);
    expect(
      isSoundJobActionable({ ...live, venueProfileStatus: "suspended" }, now),
    ).toBe(false);
    expect(
      isSoundJobActionable({ ...live, performerOwnerStatus: "suspended" }, now),
    ).toBe(false);
    expect(
      isTechSoundCancellationActionable(
        { ...live, subslotState: "booked", startsAt: now },
        now,
      ),
    ).toBe(false);
    expect(
      isPayerSoundCancellationActionable({
        ...live,
        subslotState: "booked",
        startsAt: now,
        performerProfileStatus: "suspended",
      }),
    ).toBe(true);
    expect(
      isPayerSoundCancellationActionable({
        ...live,
        subslotState: "booked",
        bookingState: "cancelled_by_venue",
      }),
    ).toBe(false);
    expect(
      payerSoundCancellationConfirmation(
        { ...live, subslotState: "booked", startsAt: now },
        now,
      ),
    ).toContain("agreed sound fee directly");
    const futureBooked = payerSoundCancellationConfirmation(
      { ...live, subslotState: "booked" },
      now,
    );
    expect(futureBooked).toContain("cancellation amount");
    expect(futureBooked).toContain("directly with the tech");
    expect(futureBooked).not.toMatch(/platform|EightGig|owed/i);
  });

  /**
   * An unparseable `startsAt` gives NaN, and every comparison with NaN is
   * false — so the plain `>` and the inverted `<=` would BOTH report "not in
   * the future" and the two surfaces would contradict each other. Both must
   * land on "already started": stop advertising the work, and tell the payer to
   * settle directly.
   */
  it("treats an unparseable start as already started on both sides", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const broken = {
      subslotState: "open",
      bookingState: "confirmed",
      startsAt: "not a date",
      venueProfileStatus: "live",
      performerProfileStatus: "live",
      venueOwnerStatus: "active",
      performerOwnerStatus: "active",
    };
    expect(isSoundParentActionable(broken, now)).toBe(false);
    expect(isSoundJobActionable(broken, now)).toBe(false);
    expect(
      isTechSoundCancellationActionable(
        { ...broken, subslotState: "booked" },
        now,
      ),
    ).toBe(false);
    expect(
      payerSoundCancellationConfirmation(
        { ...broken, subslotState: "booked" },
        now,
      ),
    ).toContain("agreed sound fee directly");
  });

  it("only offers applicant selection for a submitted, live tech with an active owner", () => {
    const available = {
      applicationStatus: "submitted",
      techProfileStatus: "live",
      techOwnerStatus: "active",
      jobIsActionable: true,
    };
    expect(isSoundApplicantBookable(available)).toBe(true);
    expect(
      isSoundApplicantBookable({
        ...available,
        applicationStatus: "declined",
      }),
    ).toBe(false);
    expect(
      isSoundApplicantBookable({
        ...available,
        techProfileStatus: "suspended",
      }),
    ).toBe(false);
    expect(
      isSoundApplicantBookable({
        ...available,
        techOwnerStatus: "suspended",
      }),
    ).toBe(false);
    expect(
      isSoundApplicantBookable({
        ...available,
        jobIsActionable: false,
      }),
    ).toBe(false);
  });

  it("distinguishes withdrawn, not-selected, and closed applications", () => {
    expect(
      soundApplicationMessage({
        applicationStatus: "withdrawn",
        subslotState: "open",
        jobIsActionable: true,
      }),
    ).toBe("You withdrew this application.");
    expect(
      soundApplicationMessage({
        applicationStatus: "declined",
        subslotState: "booked",
        jobIsActionable: false,
      }),
    ).toContain("booked another tech");
    expect(
      soundApplicationMessage({
        applicationStatus: "declined",
        subslotState: "cancelled_with_parent",
        jobIsActionable: false,
      }),
    ).toBe("This sound job closed before you were booked.");
  });

  it("does not describe a stale selected assignment as active work", () => {
    expect(
      soundAssignmentMessage({
        subslotState: "booked",
        bookingState: "confirmed",
        parentIsActionable: true,
      }),
    ).toContain("booked tech");
    expect(
      soundAssignmentMessage({
        subslotState: "booked",
        bookingState: "confirmed",
        parentIsActionable: false,
      }),
    ).toContain("still the booked tech");
    expect(
      soundAssignmentMessage({
        subslotState: "booked",
        bookingState: "cancelled_by_venue",
        parentIsActionable: false,
      }),
    ).toContain("no longer active");
    expect(
      soundAssignmentMessage({
        subslotState: "cancelled_with_parent",
        bookingState: "cancelled_by_venue",
        parentIsActionable: false,
      }),
    ).toContain("cancelled");
  });
});
