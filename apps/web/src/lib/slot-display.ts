/**
 * Treat an open slot as expired as soon as downbeat passes, even if the hourly
 * expiry sweep has not persisted that status yet. This keeps stale server
 * renders from advertising actions the API will correctly reject.
 */
export function effectiveSlotStatus(
  status: string,
  startsAt: Date,
  now: Date = new Date(),
) {
  return status === "open" && startsAt.getTime() <= now.getTime()
    ? "expired"
    : status;
}

/** Explain why a performer's application closed without inventing an outcome. */
export function declinedApplicationMessage(
  declineReason: string | null,
): string {
  switch (declineReason) {
    case "venue_declined":
      return "The venue decided not to move forward with your application. You can still browse other open gigs.";
    case "slot_filled":
      return "The venue booked another act for this date, so this application is closed.";
    case "slot_cancelled":
      return "The venue cancelled this date, so your application was closed.";
    case "slot_expired":
      return "This date passed without a booking, so your application was closed.";
    default:
      return "The venue closed this application. You can still browse other open gigs.";
  }
}
