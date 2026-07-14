// Pure calendar helpers for the voice diary (#246). The diary's storage and timeline are dated traces
// (one entry → one block under a day), so the product logic worth isolating is the date-jump calendar's
// month arithmetic. The instant → local-day-key projection lives in the shared local-day boundary
// (`localDayKey`, #606) so every routine derives "the day" from the learner's one timezone; day-grouping
// lives in the shared Timeline helper (`groupTimelineEntriesByDay`, #571). The helpers here operate on
// day/month KEYS (strings), so they are timezone-independent. No persistence, React, or I/O.

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
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
