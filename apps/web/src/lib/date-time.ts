import { zonedDateTimeToDate } from "@gigit/domain";

type DateValue = Date | string;

/**
 * A gig date, the way the scene says it: "Fri Jul 24, 8:00 PM".
 *
 * This defaulted to `dateStyle: "medium"`, which yields "Jul 24, 2026, 8:00 PM" —
 * no weekday and a year. For a bar gig the weekday IS the decision (Friday and
 * Tuesday are different jobs at different pay), and the year is noise on a feed
 * of dates inside 90 days. The year comes back automatically once a date is far
 * enough out to be genuinely ambiguous.
 */
export function formatVenueDateTime(
  value: DateValue,
  timeZone: string,
  dateStyle?: "full" | "long" | "medium" | "short",
): string {
  const when = new Date(value);
  if (dateStyle)
    return new Intl.DateTimeFormat("en-US", {
      dateStyle,
      timeStyle: "short",
      timeZone,
    }).format(when);
  const farOut =
    Math.abs(when.getTime() - Date.now()) > 300 * 86_400_000;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(farOut ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(when);
}

/**
 * A gig time the way every surface actually renders it: the venue-local time
 * followed by its zone label — "Fri Jul 24, 8:00 PM CDT".
 *
 * Fourteen call sites paired `formatVenueDateTime` with `shortTimeZoneName` on
 * the same value and zone by hand. The zone label is not decoration: without it
 * a Central gig read to a Pacific viewer as a time in their own head, which is
 * how someone shows up three hours off. Pairing them here means a surface can
 * no longer render the time and forget the zone.
 *
 * Not named for gigs: three of those sites render an offer-expiry DEADLINE, not
 * a downbeat.
 */
export function formatVenueDateTimeWithZone(
  value: DateValue,
  timeZone: string,
  dateStyle?: "full" | "long" | "medium" | "short",
): string {
  return `${formatVenueDateTime(value, timeZone, dateStyle)} ${shortTimeZoneName(value, timeZone)}`;
}

/**
 * Is this instant still ahead of `now`?
 *
 * An unparseable value gives NaN, and every comparison with NaN is false, so a
 * bad date lands on "not in the future" on its own — no finite check needed to
 * get there. That is the safe side: work stops being advertised, and
 * cancellation copy tells the payer to settle up.
 *
 * Which is exactly why callers must come through here rather than writing the
 * comparison inline. The INVERTED form `when <= now` is also false for NaN, so
 * it answers "not started" for the same bad row — two surfaces reading one
 * broken date would disagree about whether the gig has happened.
 */
export function startsInFuture(
  value: DateValue,
  now: Date = new Date(),
): boolean {
  return new Date(value).getTime() > now.getTime();
}

export function formatVenueDate(
  value: DateValue,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  },
): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(value));
}

export function shortTimeZoneName(value: DateValue, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(value))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export function friendlyTimeZoneName(timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longGeneric",
  })
    .formatToParts(new Date())
    .find((item) => item.type === "timeZoneName");
  return part?.value ?? timeZone.replaceAll("_", " ");
}

export function formatWallTime(value: string): string {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

/** Convert a datetime-local input into an ISO instant in the venue's timezone. */
export function venueLocalInputToIso(value: string, timeZone: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new RangeError("enter a complete date and time");
  return zonedDateTimeToDate(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] ?? 0),
    },
    timeZone,
  ).toISOString();
}


export function formatAddress(venue: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region: string;
  postalCode: string;
}): string {
  return [
    venue.addressLine1,
    venue.addressLine2,
    [venue.city, venue.region].filter(Boolean).join(", "),
    venue.postalCode,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function venueLocationIsComplete(venue: {
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  timeZone: string;
}): boolean {
  return (
    venue.addressLine1.trim().length > 0 &&
    venue.city.trim().length > 0 &&
    venue.region.trim().length > 0 &&
    venue.postalCode.trim().length > 0 &&
    // UTC is the migration fallback for legacy rows, not a US venue choice.
    venue.timeZone !== "UTC"
  );
}

/**
 * "2 hours ago", "Yesterday", "Jul 22" — for message and thread lists.
 *
 * These were rendered with `toLocaleString()` in a server component, i.e. in the
 * CONTAINER's timezone (UTC in production) and with no zone label at all, so an
 * 8pm Central message displayed as 1:00 AM. A server component can't know the
 * viewer's zone; relative time doesn't need it, and for a conversation it's what
 * you actually want to read.
 */
export function formatRelativeTime(value: DateValue, now: Date = new Date()): string {
  const then = new Date(value);
  const diffMs = now.getTime() - then.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  // Older than a week: a date is more useful than "37 days ago". UTC-pinned so
  // it can't shift a day depending on where this renders.
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(days > 300 ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(then);
}

/** Staff-facing timestamp. Pinned and labelled, so ops can compare log lines. */
export function formatOpsTimestamp(value: DateValue): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

/**
 * A stored metro slug → something you'd say out loud: "milwaukee" → "Milwaukee".
 *
 * Metros are lowercased on the way in (metroSchema), so every surface that shows
 * one has to title-case it. This lived as a private helper in the act profile
 * page, which is why the rooms directory nearly got a fourth copy.
 */
export function formatAreaName(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase("en-US"));
}
