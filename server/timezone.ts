// Explicit timezone handling for clock schedules (P1.2). A daily/weekdays
// routine stores the IANA zone it was created in; occurrences are the
// instants whose WALL CLOCK in that zone reads the scheduled HH:MM. DST is
// resolved deterministically: a wall time skipped by spring-forward runs at
// the first instant after the gap, and a wall time repeated by fall-back
// runs at the earlier of the two instants. Plain Intl — no dependencies.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The zone this process is running in — stamped onto new clock schedules so
 * the intended zone survives OS timezone changes and is visible in the UI. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallPartsAt(timeZone: string, epochMs: number): WallParts {
  const parts: Partial<WallParts> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(epochMs)) {
    if (type === "year" || type === "month" || type === "day" || type === "hour" || type === "minute" || type === "second") {
      parts[type] = Number(value);
    }
  }
  return parts as WallParts;
}

/** The zone's wall clock at `epochMs`, re-encoded as a UTC epoch of the same
 * calendar fields — subtracting the real epoch gives the zone offset. */
function wallAsUtc(timeZone: string, epochMs: number): number {
  const p = wallPartsAt(timeZone, epochMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The instant whose wall clock in `timeZone` reads the given calendar
 * fields. DST gap → first instant after the gap; DST repeat → earlier
 * instant. */
export function zonedEpoch(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const c1 = desired - (wallAsUtc(timeZone, desired) - desired);
  const c2 = desired - (wallAsUtc(timeZone, c1) - c1);
  if (wallAsUtc(timeZone, c2) === desired) {
    // fall-back can make the wall time ambiguous; deterministically prefer
    // the earlier instant (DST deltas are 30 or 60 minutes in practice)
    for (const delta of [3_600_000, 1_800_000]) {
      if (wallAsUtc(timeZone, c2 - delta) === desired) return c2 - delta;
    }
    return c2;
  }
  // spring-forward gap: the wall time never happens. Binary-search the two
  // candidates (which straddle the transition) for the first instant whose
  // wall clock is at or past the requested time.
  let lo = Math.min(c1, c2);
  let hi = Math.max(c1, c2);
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (wallAsUtc(timeZone, mid) >= desired) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Next instant strictly after `from` whose wall clock in `timeZone` reads
 * `time` (HH:MM), optionally restricted to Mon–Fri in that zone. */
export function zonedNextClockRun(timeZone: string, time: string, weekdaysOnly: boolean, from: number): number {
  const [hour, minute] = time.split(":").map(Number);
  const start = wallPartsAt(timeZone, from);
  for (let i = 0; i < 9; i++) {
    // UTC calendar arithmetic walks dates without DST distortion; the
    // weekday of a calendar date is zone-independent once we have Y-M-D
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const dow = date.getUTCDay();
    if (weekdaysOnly && (dow === 0 || dow === 6)) continue;
    const t = zonedEpoch(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
    if (t > from) return t;
  }
  throw new Error("invalid clock schedule");
}
