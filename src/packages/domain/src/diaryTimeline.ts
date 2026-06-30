// Pure date/grouping helpers for the voice diary (#246). The diary's storage and timeline are dated
// traces (one entry → one block under a day), so the only product logic worth isolating is the date-key
// derivation, the day-grouping (newest-first, stable within a day), and the date-jump calendar's month
// grid. No persistence, React, or I/O — the server and client feed in values and render the result.

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

// The `YYYY-MM-DD` day key a `Date` falls on, read in UTC so the same instant maps to the same day on
// every machine (the server stamps `entry_date` from its clock; tests pass fixed instants). v0 treats
// the UTC calendar day as "the day"; a per-user local-day refinement is a later concern.
export function toDayKey(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
    date.getUTCDate(),
    2
  )}`;
}

// Whether a string is a well-formed `YYYY-MM-DD` day key. Used at the API boundary to reject a malformed
// cursor/range before it reaches a query.
export function isDayKey(value: string): boolean {
  return DAY_KEY_PATTERN.test(value);
}

// The `YYYY-MM` month key a day key belongs to (its first seven characters).
export function toMonthKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

// A dated entry: just enough for grouping. Generic over the carried payload so the diary's entries and
// any future dated trace (notes, practice deposits) group the same way.
export type DatedEntry = Readonly<{ createdAt: string; date: string }>;

export type DayGroup<TEntry extends DatedEntry> = Readonly<{
  date: string;
  entries: ReadonlyArray<TEntry>;
}>;

// Group dated entries into days, newest day first, with each day's entries oldest-first by `createdAt`
// (then by a stable original-order tiebreak so equal timestamps never reorder). This is the timeline
// shape: day-grouped, newest-first, an entry stacking under its day in capture order.
export function groupByDayDesc<TEntry extends DatedEntry>(
  entries: ReadonlyArray<TEntry>
): ReadonlyArray<DayGroup<TEntry>> {
  const byDay = new Map<string, TEntry[]>();
  entries.forEach((entry) => {
    const bucket = byDay.get(entry.date);
    if (bucket === undefined) {
      byDay.set(entry.date, [entry]);
    } else {
      bucket.push(entry);
    }
  });

  return [...byDay.entries()]
    .sort(([leftDate], [rightDate]) => (leftDate < rightDate ? 1 : -1))
    .map(([date, dayEntries]) => ({
      date,
      entries: [...dayEntries].sort((left, right) =>
        left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
      )
    }));
}

// The inclusive first and last day keys of a `YYYY-MM` month — the range the calendar asks the server to
// mark (which of these days have ≥1 entry).
export function monthBounds(monthKey: string): Readonly<{ from: string; to: string }> {
  const [year, month] = splitMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad(lastDay, 2)}` };
}

// Shift a `YYYY-MM` month key by whole months (prev/next navigation). Negative goes back.
export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = splitMonthKey(monthKey);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}`;
}

// A month laid out as calendar weeks (Sunday-first): each cell is its `YYYY-MM-DD` day key, or null for a
// leading/trailing blank so the grid is rectangular. The minimal shape a small date-jump calendar renders
// without a date library.
export function monthGrid(monthKey: string): ReadonlyArray<ReadonlyArray<string | null>> {
  const [year, month] = splitMonthKey(monthKey);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: (string | null)[] = [];
  for (let blank = 0; blank < firstWeekday; blank += 1) {
    cells.push(null);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${monthKey}-${pad(day, 2)}`);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  const weeks: (string | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) {
    weeks.push(cells.slice(start, start + 7));
  }
  return weeks;
}

function splitMonthKey(monthKey: string): readonly [number, number] {
  if (!MONTH_KEY_PATTERN.test(monthKey)) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  return [Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7))];
}
