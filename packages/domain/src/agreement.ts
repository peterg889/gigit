import type { BookingTerms } from "./booking/states.js";

export const AGREEMENT_TEMPLATE_VERSION = "v1";

/**
 * Click-wrap performance agreement (engineering-spec K7). Deterministic
 * render from locked terms; both parties accept this exact text in-flow and
 * the acceptance event records the template version. Not legal advice;
 * template to be reviewed by counsel before launch (PRD risk table).
 */
export function renderAgreement(input: {
  venueName: string;
  performerName: string;
  terms: BookingTerms;
  /**
   * Discovery-first launch (default false): Gigit doesn't process the money,
   * so the doc is a plain terms summary — no charge/escrow/payout or fee-
   * schedule clauses. The full click-wrap contract returns with the payments
   * rail (docs/pricing.md). Callers pass paymentsEnabled().
   */
  paymentsEnabled?: boolean;
}): string {
  const { venueName, performerName, terms, paymentsEnabled = false } = input;
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
      `directly between the two of them. Gigit does not charge, hold, or pay ` +
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
    ? `Accepted electronically by both parties on the Gigit platform.`
    : `Agreed by both parties on Gigit — the record of the booking. Gigit is the ` +
      `introduction and the handshake, not a party to the payment.`;

  return [
    paymentsEnabled
      ? `PERFORMANCE AGREEMENT (Gigit template ${AGREEMENT_TEMPLATE_VERSION})`
      : `BOOKING TERMS (Gigit ${AGREEMENT_TEMPLATE_VERSION})`,
    ``,
    `Venue: ${venueName}`,
    `Performer: ${performerName}`,
    ``,
    `1. PERFORMANCE. ${performerName} will perform at ${venueName} from ` +
      `${terms.startsAt} to ${terms.endsAt} (UTC)` +
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
