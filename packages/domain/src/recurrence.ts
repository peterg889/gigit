/**
 * Recurring nights are defined in the venue's wall clock, then materialized
 * as UTC instants. That keeps "Friday at 8 PM" at 8 PM through DST changes.
 * Legacy UTC patterns remain readable so existing series do not break.
 */

type PatternBase = {
  dayOfWeek: number; // 0=Sun … 6=Sat
  durationMinutes: number;
  /**
   * Exact first occurrence selected when the series was created. New patterns
   * carry this ISO instant as an inclusive lower bound; its absence preserves
   * the behavior of series stored before recurrence anchoring was introduced.
   */
  firstStartsAt?: string;
  /** Venue wall-clock time ("HH:MM") for all newly-created series. */
  startTimeLocal?: string;
  /** IANA timezone paired with startTimeLocal. */
  timeZone?: string;
  /** Pre-timezone compatibility field. */
  startTimeUtc?: string;
};

export type SeriesPattern =
  | (PatternBase & { freq: "weekly" })
  | (PatternBase & {
      freq: "monthly_dow"; // "first Tuesday", "third Friday" …
      week: 1 | 2 | 3 | 4 | 5; // 5 = last
    });

export interface LocalDateTime {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

/** Calendar fields for an instant as seen in an IANA timezone. */
export function localDateTimeParts(date: Date, timeZone: string): Required<LocalDateTime> {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * Convert venue-local calendar fields to a UTC instant without relying on the
 * process or browser timezone. A nonexistent DST wall-clock time (the
 * spring-forward gap) throws by default — right for validating a time a user
 * just typed — but pattern-generated times pass `resolveGapForward` so
 * "every Friday 2:30 AM" lands at 3:30 AM on the transition night, like
 * common schedulers, instead of aborting materialization.
 */
/**
 * A venue-local wall time → the instant it names.
 *
 * DST makes this two-sided and both sides matter for a series:
 *
 * - **Spring forward** removes an hour, so the requested time may not exist.
 *   Throws by default; `resolveGapForward` moves to the first real instant after
 *   the jump (what a weekly night should do rather than vanish).
 * - **Fall back** repeats an hour, so the requested time exists TWICE. This
 *   returns the **earlier** instant — the first 1:30 AM, not the second. That's
 *   the conventional resolution, and it has to be a documented guarantee rather
 *   than an accident of the loop below: `materializeSeries` keys its unique index
 *   on the resolved instant, so a change of mind here would both move a booked
 *   gig by an hour and silently duplicate the occurrence.
 */
export function zonedDateTimeToDate(
  local: LocalDateTime,
  timeZone: string,
  opts: { resolveGapForward?: boolean } = {},
): Date {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second ?? 0,
  );
  let candidate = target;
  let afterGap: number | undefined;
  for (let i = 0; i < 4; i += 1) {
    const actual = localDateTimeParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = target - actualAsUtc;
    if (delta === 0) return new Date(candidate);
    // In a gap the iteration oscillates between an instant before the jump
    // and one after; the one whose wall clock is past the requested time is
    // the forward resolution.
    if (actualAsUtc > target) afterGap = candidate;
    candidate += delta;
  }
  if (opts.resolveGapForward && afterGap !== undefined) return new Date(afterGap);
  throw new RangeError("That local time does not exist in the selected time zone.");
}

/** Derive a venue-local pattern from a concrete first occurrence. */
export function patternFromFirst(
  firstStartsAt: Date,
  durationMinutes: number,
  freq: "weekly" | "monthly_dow",
  timeZone = "UTC",
): SeriesPattern {
  const local = localDateTimeParts(firstStartsAt, timeZone);
  // UTC is used here only as a calendar arithmetic container for local fields.
  const dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const startTimeLocal = `${String(local.hour).padStart(2, "0")}:${String(
    local.minute,
  ).padStart(2, "0")}`;
  const base = {
    dayOfWeek,
    firstStartsAt: firstStartsAt.toISOString(),
    startTimeLocal,
    timeZone,
    durationMinutes,
  };
  if (freq === "weekly") return { freq, ...base };
  const week = (Math.floor((local.day - 1) / 7) + 1) as 1 | 2 | 3 | 4 | 5;
  return { freq, week, ...base };
}

/** Next `count` occurrence start datetimes strictly after `after`. */
export function nextOccurrences(
  pattern: SeriesPattern,
  after: Date,
  count: number,
): Date[] {
  if (count <= 0) return [];
  if (!pattern.startTimeLocal || !pattern.timeZone)
    return nextLegacyUtcOccurrences(pattern, after, count);

  const out: Date[] = [];
  const [hour = 0, minute = 0] = pattern.startTimeLocal.split(":").map(Number);
  const window = occurrenceWindow(pattern, after);
  const afterLocal = localDateTimeParts(window.searchAfter, pattern.timeZone);

  if (pattern.freq === "weekly") {
    const cursor = new Date(Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day));
    while (out.length < count) {
      if (cursor.getUTCDay() === pattern.dayOfWeek) {
        const candidate = zonedDateTimeToDate(
          {
            year: cursor.getUTCFullYear(),
            month: cursor.getUTCMonth() + 1,
            day: cursor.getUTCDate(),
            hour,
            minute,
          },
          pattern.timeZone,
          { resolveGapForward: true },
        );
        if (window.includes(candidate)) out.push(candidate);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  let year = afterLocal.year;
  let month = afterLocal.month - 1;
  while (out.length < count) {
    const civil = nthWeekdayOfMonth(year, month, pattern.dayOfWeek, pattern.week);
    if (civil) {
      const candidate = zonedDateTimeToDate(
        {
          year,
          month: month + 1,
          day: civil.getUTCDate(),
          hour,
          minute,
        },
        pattern.timeZone,
        { resolveGapForward: true },
      );
      if (window.includes(candidate)) out.push(candidate);
    }
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

function nextLegacyUtcOccurrences(
  pattern: SeriesPattern,
  after: Date,
  count: number,
): Date[] {
  const out: Date[] = [];
  const window = occurrenceWindow(pattern, after);
  const [h = 0, m = 0] = (pattern.startTimeUtc ?? "00:00").split(":").map(Number);
  if (pattern.freq === "weekly") {
    const cursor = new Date(window.searchAfter);
    cursor.setUTCHours(h, m, 0, 0);
    while (
      cursor.getUTCDay() !== pattern.dayOfWeek ||
      !window.includes(cursor)
    )
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    while (out.length < count) {
      out.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return out;
  }

  let year = window.searchAfter.getUTCFullYear();
  let month = window.searchAfter.getUTCMonth();
  while (out.length < count) {
    const d = nthWeekdayOfMonth(year, month, pattern.dayOfWeek, pattern.week);
    if (d) {
      d.setUTCHours(h, m, 0, 0);
      if (window.includes(d)) out.push(d);
    }
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

/**
 * Start calendar scanning at the later of `after` and just before the optional
 * first occurrence. The original `after` remains a strict boundary, while the
 * persisted first occurrence is inclusive so it materializes exactly once.
 */
function occurrenceWindow(pattern: SeriesPattern, after: Date) {
  const afterMs = after.getTime();
  const firstStartsAtMs = pattern.firstStartsAt
    ? new Date(pattern.firstStartsAt).getTime()
    : undefined;
  if (firstStartsAtMs !== undefined && !Number.isFinite(firstStartsAtMs))
    throw new RangeError("Series first occurrence is not a valid date.");
  const searchAfter =
    firstStartsAtMs !== undefined && firstStartsAtMs > afterMs
      ? new Date(firstStartsAtMs - 1)
      : after;
  return {
    searchAfter,
    includes(candidate: Date): boolean {
      const candidateMs = candidate.getTime();
      return (
        candidateMs > afterMs &&
        (firstStartsAtMs === undefined || candidateMs >= firstStartsAtMs)
      );
    },
  };
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  dayOfWeek: number,
  week: 1 | 2 | 3 | 4 | 5,
): Date | null {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7;
  if (week === 5) {
    const fourth = 1 + offset + 21;
    const candidate = fourth + 7;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, candidate <= daysInMonth ? candidate : fourth));
  }
  const day = 1 + offset + (week - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return new Date(Date.UTC(year, month, day));
}
