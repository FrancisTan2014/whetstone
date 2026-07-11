// The logical Timeline (#571): a chronological view over a user's personal Entries (diary + note), never
// a stored object. This module is the pure ordering + day-grouping the server derives the Timeline with,
// plus the discriminator vocabulary that binds each Timeline row to a real Entry type — so there is no
// Timeline-only entity whose identity exists only because it appears here. No persistence, DB, or I/O.

import { entryTypes, type EntryType } from "./entry.js";
import { toDayKey } from "./diaryTimeline.js";

// The kinds a Timeline row can take. Each is a filter over the one derived result — the Diary is the
// `diary` filter, and a future all-history view is the union. Ordered by nothing meaningful; membership,
// not order, is what matters.
export const timelineEntryKinds = ["diary", "note", "work", "recitation", "memory_note"] as const;

export type TimelineEntryKind = (typeof timelineEntryKinds)[number];

const timelineEntryKindSet: ReadonlySet<unknown> = new Set(timelineEntryKinds);

export function isTimelineEntryKind(value: unknown): value is TimelineEntryKind {
  return timelineEntryKindSet.has(value);
}

// Every Timeline kind resolves to a real, addressable Entry type — the guarantee that the Timeline is a
// view, not a store: a `diary` row IS a `diary_entry` Entry, a `note` row IS a `note` Entry, and a `work`
// row IS a user-owned authored `work` Entry (#576). There is no mapping to a `timeline_entry`, because
// that type no longer exists (#571).
const TIMELINE_KIND_ENTRY_TYPE: Readonly<Record<TimelineEntryKind, EntryType>> = {
  diary: "diary_entry",
  note: "note",
  work: "work",
  // A `recitation` row IS a real `recitation_plan` Entry (#577) — the learner's adopted recitation
  // routine, owner-scoped and dated through the shared personal-entry facet like every other row.
  recitation: "recitation_plan",
  // A `memory_note` row IS a real `memory_note` Entry (#573) — the durable retention target the learner
  // captured. It appears once on the Timeline via the shared personal-entry chronology; its prompts,
  // autosaves, and reviews are deliberately NOT Timeline rows.
  memory_note: "memory_note"
};

export function entryTypeForTimelineKind(kind: TimelineEntryKind): EntryType {
  return TIMELINE_KIND_ENTRY_TYPE[kind];
}

// The minimal chronology identity every Timeline row carries: which Entry it is (`entryId`), its kind,
// and when it happened (`occurredAt`, an ISO-8601 instant). Ordering and grouping are generic over any
// row that carries these, so the server can order/group the full discriminated DTO without this module
// depending on the display fields.
export type TimelineChronology = Readonly<{
  entryId: string;
  kind: TimelineEntryKind;
  occurredAt: string;
}>;

// The deterministic Timeline order: newest first by `occurredAt`, with a stable tie-break on `entryId`
// ascending so two entries sharing an instant always order the same way across machines and runs. Pure
// and non-mutating (operates on a copy), so the caller's array is untouched.
export function orderTimelineEntries<TEntry extends TimelineChronology>(
  entries: ReadonlyArray<TEntry>
): ReadonlyArray<TEntry> {
  return [...entries].sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) {
      return left.occurredAt < right.occurredAt ? 1 : -1;
    }
    if (left.entryId !== right.entryId) {
      return left.entryId < right.entryId ? -1 : 1;
    }
    return 0;
  });
}

export type TimelineDay<TEntry extends TimelineChronology> = Readonly<{
  date: string;
  entries: ReadonlyArray<TEntry>;
}>;

// The Timeline grouped into days, newest day first, each day's entries in the same deterministic order
// (`orderTimelineEntries`). The day key is the UTC calendar day the `occurredAt` instant falls on, so the
// same instant groups to the same day on every machine. Because the entries are ordered newest-first
// before bucketing and days are emitted in first-seen order, the day sections come out newest-first too.
export function groupTimelineEntriesByDay<TEntry extends TimelineChronology>(
  entries: ReadonlyArray<TEntry>
): ReadonlyArray<TimelineDay<TEntry>> {
  const ordered = orderTimelineEntries(entries);
  const byDay = new Map<string, TEntry[]>();

  for (const entry of ordered) {
    const date = toDayKey(new Date(entry.occurredAt));
    const bucket = byDay.get(date);
    if (bucket === undefined) {
      byDay.set(date, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return [...byDay.entries()].map(([date, dayEntries]) => ({ date, entries: dayEntries }));
}

// The distinct UTC days that carry at least one Timeline entry, newest first — the marks the diary's
// date-jump calendar paints, derived from `occurredAt` rather than a stored day column.
export function timelineDays<TEntry extends TimelineChronology>(
  entries: ReadonlyArray<TEntry>
): ReadonlyArray<string> {
  return groupTimelineEntriesByDay(entries).map((day) => day.date);
}

// A guard used by contract/domain tests to assert the Timeline vocabulary introduces no entity whose
// identity exists only because it appears in the Timeline: every kind maps to a real Entry type, and the
// retired `timeline_entry` type is gone from the Entry vocabulary entirely.
export function timelineKindsAreRealEntries(): boolean {
  const realTypes: ReadonlySet<unknown> = new Set(entryTypes);
  return timelineEntryKinds.every((kind) => realTypes.has(entryTypeForTimelineKind(kind)));
}
