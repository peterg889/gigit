import { localDateTimeParts, zonedDateTimeToDate } from "@gigit/domain";

type DateValue = Date | string;

export function formatVenueDateTime(
  value: DateValue,
  timeZone: string,
  dateStyle: "full" | "long" | "medium" | "short" = "medium",
): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle,
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
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

export function venueLocalInputValue(value: DateValue, timeZone: string): string {
  const p = localDateTimeParts(new Date(value), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(
    2,
    "0",
  )}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
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
