import type { BookingTerms } from "./booking/states.js";

export const AGREEMENT_TEMPLATE_VERSION = "v2";

function formatTermTime(value: string, timeZone?: string): string {
  if (!timeZone) return `${value} (UTC)`;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

/**
 * Click-wrap performance agreement (engineering-spec K7). Deterministic
 * render from locked terms; both parties accept this exact text in-flow and
 * the acceptance event records the template version. Not legal advice;
 * template to be reviewed by counsel before launch (PRD risk table).
 */
export function renderAgreement(input: {
  venueName: string;
  venueAddress?: string;
  performerName: string;
  terms: BookingTerms;
  /** Venue timezone used in the customer-visible accepted terms. */
  timeZone?: string;
  /**
   * Discovery-first launch (default false): EightGig doesn't process the money,
   * so the doc is a plain terms summary — no charge/escrow/payout or fee-
   * schedule clauses. The full click-wrap contract returns with the payments
   * rail (docs/pricing.md). Callers pass paymentsEnabled().
   */
  paymentsEnabled?: boolean;
  /** Stored with the booking so accepted text remains immutable across revisions. */
  templateVersion?: string;
}): string {
  const {
    venueName,
    venueAddress,
    performerName,
    terms,
    timeZone,
    paymentsEnabled = false,
    templateVersion = AGREEMENT_TEMPLATE_VERSION,
  } = input;
  const brandName = templateVersion === "v1" ? "Gigit" : "EightGig";
  const lockedVenueAddress = terms.venueAddress ?? venueAddress;
  const lockedTimeZone = terms.timeZone ?? timeZone;
  const startsAt = formatTermTime(terms.startsAt, lockedTimeZone);
  const endsAt = formatTermTime(terms.endsAt, lockedTimeZone);
  const amount = `$${(terms.amountCents / 100).toFixed(2)}`;
  const provides: string[] = [];
  if (terms.provides?.pa) provides.push("house PA system");
  if (terms.provides?.meal) provides.push("meal for performers");
  if (terms.provides?.parking) provides.push("parking");

  const compensation = paymentsEnabled
    ? `2. COMPENSATION. ${venueName} pays ${amount}, charged at confirmation, held ` +
      `by the platform, and released to ${performerName} 24 hours after the ` +
      `performance ends unless a dispute is opened.`
    : `2. COMPENSATION. ${venueName} pays ${performerName} ${amount}, settled ` +
      `directly between the two of them. ${brandName} does not charge, hold, or pay ` +
      `out this money.`;
  const venueCancellation = paymentsEnabled
    ? `4. CANCELLATION BY VENUE. More than 14 days before start: full refund. ` +
      `Between 14 days and 48 hours: 50% of the fee is paid to the performer. ` +
      `Within 48 hours: 100% of the fee is paid to the performer.`
    : `4. CANCELLATION BY VENUE. The slot reopens immediately and repeated late ` +
      `cancellations affect the venue's standing on the platform. Any pay ` +
      `already arranged is settled directly between the parties.`;
  const performerCancellation = paymentsEnabled
    ? `5. CANCELLATION BY PERFORMER. Full refund to the venue; repeated late ` +
      `cancellations affect the performer's standing on the platform.`
    : `5. CANCELLATION BY PERFORMER. The slot reopens for other acts; repeated ` +
      `late cancellations affect the performer's standing on the platform.`;
  const closing = paymentsEnabled
    ? `Accepted electronically by both parties on the ${brandName} platform.`
    : `Agreed by both parties on ${brandName} — the record of the booking. ${brandName} is the ` +
      `introduction and the handshake, not a party to the payment.`;

  return [
    paymentsEnabled
      ? `PERFORMANCE AGREEMENT (${brandName} template ${templateVersion})`
      : `BOOKING TERMS (${brandName} ${templateVersion})`,
    ``,
    `Venue: ${venueName}`,
    ...(lockedVenueAddress ? [`Location: ${lockedVenueAddress}`] : []),
    `Performer: ${performerName}`,
    ``,
    `1. PERFORMANCE. ${performerName} will perform at ${venueName} from ` +
      `${startsAt} to ${endsAt}` +
      (terms.setLengthMinutes ? `, set length ${terms.setLengthMinutes} minutes` : "") +
      `.`,
    compensation,
    `3. PROVIDED BY VENUE. ${provides.length ? provides.join(", ") : "nothing beyond the performance space"}.`,
    venueCancellation,
    performerCancellation,
    `6. NOTES. ${terms.notes ?? "—"}`,
    ``,
    closing,
  ].join("\n");
}
