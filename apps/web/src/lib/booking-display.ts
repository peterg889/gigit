import type { BookingState } from "@gigit/domain";

const CONTACT_VISIBLE_STATES: ReadonlySet<BookingState> = new Set([
  "confirmed",
  "awaiting_confirmation",
  "disputed",
  "released",
  "refunded",
  "partially_released",
]);

/** Contact details unlock after confirmation and remain available thereafter. */
export function bookingContactsAreVisible(
  state: BookingState,
  wasConfirmed = false,
): boolean {
  if (
    state === "cancelled_by_venue" ||
    state === "cancelled_by_performer"
  ) {
    return wasConfirmed;
  }
  return CONTACT_VISIBLE_STATES.has(state);
}

export interface ConfirmedCancellationCopy {
  confirm: string;
  consequence: string;
  dateReopens: boolean;
}

/** Cancellation wording must match the transition's downbeat-aware slot effect. */
export function confirmedCancellationCopy(
  input: {
    role: "venue" | "performer";
    paymentsEnabled: boolean;
    startsAt: Date | string;
  },
  now: Date = new Date(),
): ConfirmedCancellationCopy {
  const startsAt =
    input.startsAt instanceof Date
      ? input.startsAt
      : new Date(input.startsAt);
  const dateReopens =
    Number.isFinite(startsAt.getTime()) && startsAt.getTime() > now.getTime();
  const dateOutcome = dateReopens
    ? "The date reopens."
    : "The date will not reopen because the gig has already started.";

  if (input.role === "venue") {
    const paymentOutcome = input.paymentsEnabled
      ? dateReopens
        ? "Per the agreement, the closer to the date the more of the act's fee is owed."
        : "Per the agreement, the act's full fee is still owed."
      : "Settle any pay directly with the act.";
    return {
      confirm: `Cancel this booking? ${dateOutcome} ${paymentOutcome}`,
      consequence: dateReopens
        ? input.paymentsEnabled
          ? "Reopens the date; per the agreement you owe more of the fee the closer to the date."
          : "Reopens the date; settle anything arranged with the act directly."
        : input.paymentsEnabled
          ? "The date will not reopen; per the agreement the act's full fee is still owed."
          : "The date will not reopen; settle anything arranged with the act directly.",
      dateReopens,
    };
  }

  return {
    confirm: dateReopens
      ? "Cancel this booking? The date reopens for the venue, and a cancellation counts against your reliability."
      : "Cancel this booking? The date will not reopen because the gig has already started, and the cancellation counts against your reliability.",
    consequence: dateReopens
      ? "Reopens the date; counts against your reliability. No fee owed."
      : "The date will not reopen; counts against your reliability. No fee owed.",
    dateReopens,
  };
}
