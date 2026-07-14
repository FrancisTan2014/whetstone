// The learner's local calendar-day boundary (#606). Raw instants are always stored as UTC; the learner
// has ONE calendar day for every routine, defined by their persisted IANA timezone. This module is the
// single pure projection from an instant to "which local day is it, and which UTC instants bound that
// day" — every feature that groups by day or caps per day derives its day from here, so Today,
// Recitation, and Diary can never disagree about what "today" means or reset at a machine-dependent
// midnight. No persistence, React, DB, or I/O: it is exact, machine-independent arithmetic over `Intl`.

export type LocalDayBoundary = Readonly<{
  // The `YYYY-MM-DD` calendar day the instant falls on IN the given zone.
  dateKey: string;
  // The instant that local day starts (local 00:00:00) — the inclusive lower bound of the day.
  utcStart: Date;
  // The instant the NEXT local day starts — the exclusive upper bound. `utcEnd - utcStart` is not always
  // 24h (a DST transition makes a local day 23h or 25h), which is exactly why the day is returned as two
  // instants rather than a fixed span.
  utcEnd: Date;
}>;

type ZonedParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

// Whether `timeZone` is an IANA zone id this runtime knows. `Intl.DateTimeFormat` throws `RangeError`
// for an unknown/invalid id, so a successful construction is the validation. Used at the write boundary
// (reject an invalid stored zone) and by the boundary itself, so an invalid zone is never silently
// reinterpreted as the server's zone.
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The wall-clock parts of `instant` as read in `timeZone` (24-hour, second resolution). `hourCycle:h23`
// keeps midnight "00" rather than a 24 some engines emit, so a day always starts at hour 0. The parts are
// collected into a fully-keyed record — literal separators the formatter emits (`/`, `:`, spaces) are the
// keys not in it and are skipped — so every field is a definite number.
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(instant);

  const collected = { day: 0, hour: 0, minute: 0, month: 0, second: 0, year: 0 };
  for (const part of formatted) {
    if (part.type in collected) {
      collected[part.type as keyof typeof collected] = Number(part.value);
    }
  }

  return collected;
}

// The zone's offset (zoneTime − UTC) in milliseconds at `instant`: read the zoned wall clock, treat it as
// if it were UTC, and subtract the true instant (floored to whole seconds so sub-second `now` never leaks
// into the offset, which is always a whole number of minutes).
function offsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The UTC instant at which the local wall clock in `timeZone` reads `year-month-day 00:00:00`. Guess the
// instant is UTC, find the offset there, correct by it, then re-check the offset at the corrected instant
// so a DST jump between guess and answer is absorbed (two passes converge for every real zone).
function startOfLocalDay(year: number, month: number, day: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstOffset = offsetMs(new Date(wallAsUtc), timeZone);
  const secondOffset = offsetMs(new Date(wallAsUtc - firstOffset), timeZone);
  return new Date(wallAsUtc - secondOffset);
}

// The `YYYY-MM-DD` day key the instant falls on in `timeZone`. The cheap projection consumers use to
// group traces by day; `localDayBoundary` shares the same parts so a key and its bounds always agree.
export function localDayKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

// The learner's local calendar day for `now`: its `YYYY-MM-DD` key and the UTC instants that bound it
// (`utcStart` inclusive, `utcEnd` exclusive). Throws on an invalid IANA id rather than guess a zone. The
// next-day label is computed by a pure UTC date increment, so month/year/leap rollover is exact, and the
// bounds are re-derived from that label so DST-length days stay correct.
export function localDayBoundary(now: Date, timeZone: string): LocalDayBoundary {
  if (!isTimeZone(timeZone)) {
    throw new RangeError(`Invalid IANA timezone: ${timeZone}`);
  }

  const parts = zonedParts(now, timeZone);
  const dateKey = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
  const utcStart = startOfLocalDay(parts.year, parts.month, parts.day, timeZone);

  const nextLabel = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const utcEnd = startOfLocalDay(
    nextLabel.getUTCFullYear(),
    nextLabel.getUTCMonth() + 1,
    nextLabel.getUTCDate(),
    timeZone
  );

  return { dateKey, utcEnd, utcStart };
}
