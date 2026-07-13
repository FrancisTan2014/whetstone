import type { DiaryEntryDto, TimelineDayDto, TimelineEntryDto } from "@whetstone/contracts";
import { groupTimelineEntriesByDay, toDayKey } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  diaryEntries,
  memoryNotes,
  memoryPrompts,
  notes,
  personalEntries,
  recitationPlans,
  workMeta
} from "../../db/schema.js";

// The Diary reads the logical Timeline (#571): a chronological view derived by querying the current
// user's personal Entries — never a stored Timeline object. A diary read scopes every join to
// `personal_entries.user_id`, so one user never sees another's entries.

// A diary row surfaces in the Timeline only when ready to display: a synchronous typed capture
// (`processing_status` null) or a voice capture the worker finished (`ready`). An in-flight or failed
// async voice capture (queued/transcribing/tidying/failed) is NOT shown — its body is an empty
// placeholder; the frontend polls the voice-capture status endpoint for those instead.
function readyDiary() {
  return or(isNull(diaryEntries.processingStatus), eq(diaryEntries.processingStatus, "ready"));
}

// The current user's personal Entries as discriminated Timeline rows (diary + note): a `diary` row
// carries its rich body, a `note` row its markdown text. Both draw chronology from the shared
// `personal_entries` facet. Combined here (unordered); the pure domain `groupTimelineEntriesByDay`
// orders and buckets them deterministically, so no Timeline-only entity exists.
async function loadPersonalTimelineEntries(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<TimelineEntryDto>> {
  const diaryRows = await db
    .select({
      bodyDoc: diaryEntries.bodyDoc,
      bodyText: diaryEntries.bodyText,
      entryId: diaryEntries.entryId,
      language: diaryEntries.language,
      occurredAt: personalEntries.occurredAt
    })
    .from(diaryEntries)
    .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
    .where(and(eq(personalEntries.userId, userId), readyDiary()));

  const noteRows = await db
    .select({
      entryId: notes.entryId,
      occurredAt: personalEntries.occurredAt,
      text: notes.markdownBody
    })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .where(eq(personalEntries.userId, userId));

  // An authored (owned) Work is a personal Entry too (#576): it draws chronology from the same
  // `personal_entries` facet, so it surfaces on the learner's Timeline alongside diary entries and notes.
  const workRows = await db
    .select({
      entryId: workMeta.entryId,
      occurredAt: personalEntries.occurredAt,
      title: workMeta.title
    })
    .from(workMeta)
    .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
    .where(eq(personalEntries.userId, userId));

  // A recitation plan is a personal Entry too (#577): it draws chronology from the same `personal_entries`
  // facet and carries the source Work's title, so the learner's adopted routine surfaces on the Timeline.
  // Its per-session routine state is deliberately NOT joined — a reading session is not a Timeline row.
  const recitationRows = await db
    .select({
      entryId: recitationPlans.entryId,
      occurredAt: personalEntries.occurredAt,
      phase: recitationPlans.phase,
      title: workMeta.title,
      workEntryId: recitationPlans.workEntryId
    })
    .from(recitationPlans)
    .innerJoin(personalEntries, eq(personalEntries.entryId, recitationPlans.entryId))
    .innerJoin(workMeta, eq(workMeta.entryId, recitationPlans.workEntryId))
    .where(eq(personalEntries.userId, userId));

  // A Memory note is a personal Entry too (#573): it draws chronology from the same `personal_entries`
  // facet, so it appears ONCE on the Timeline. Its prompts, autosaves, and reviews are deliberately NOT
  // joined — they are not Timeline rows; only the note is, carrying its fragment and a prompt count.
  const memoryNoteRows = await db
    .select({
      bodyText: memoryNotes.bodyText,
      captureSource: memoryNotes.captureSource,
      entryId: memoryNotes.entryId,
      occurredAt: personalEntries.occurredAt
    })
    .from(memoryNotes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, memoryNotes.entryId))
    .where(eq(personalEntries.userId, userId));
  const memoryNoteIds = memoryNoteRows.map((row) => row.entryId);
  const promptCounts =
    memoryNoteIds.length === 0
      ? []
      : await db
          .select({ noteEntryId: memoryPrompts.noteEntryId, total: count() })
          .from(memoryPrompts)
          .where(inArray(memoryPrompts.noteEntryId, memoryNoteIds))
          .groupBy(memoryPrompts.noteEntryId);
  const promptCountByNote = new Map(
    promptCounts.map((row) => [row.noteEntryId, Number(row.total)])
  );

  const diaryTimeline: ReadonlyArray<TimelineEntryDto> = diaryRows.map((row) => ({
    bodyDoc: row.bodyDoc as DocumentNodeJSON,
    bodyText: row.bodyText,
    entryId: row.entryId,
    kind: "diary",
    language: row.language,
    occurredAt: row.occurredAt.toISOString()
  }));
  const noteTimeline: ReadonlyArray<TimelineEntryDto> = noteRows.map((row) => ({
    entryId: row.entryId,
    kind: "note",
    occurredAt: row.occurredAt.toISOString(),
    text: row.text
  }));
  const workTimeline: ReadonlyArray<TimelineEntryDto> = workRows.map((row) => ({
    entryId: row.entryId,
    kind: "work",
    occurredAt: row.occurredAt.toISOString(),
    title: row.title,
    workEntryId: row.entryId
  }));
  const recitationTimeline: ReadonlyArray<TimelineEntryDto> = recitationRows.map((row) => ({
    entryId: row.entryId,
    kind: "recitation",
    occurredAt: row.occurredAt.toISOString(),
    phase: row.phase,
    title: row.title,
    workEntryId: row.workEntryId
  }));
  const memoryTimeline: ReadonlyArray<TimelineEntryDto> = memoryNoteRows.map((row) => ({
    bodyText: row.bodyText,
    captureSource: row.captureSource,
    entryId: row.entryId,
    kind: "memory_note",
    occurredAt: row.occurredAt.toISOString(),
    promptCount: promptCountByNote.get(row.entryId) ?? 0
  }));

  return [
    ...diaryTimeline,
    ...noteTimeline,
    ...workTimeline,
    ...recitationTimeline,
    ...memoryTimeline
  ];
}

// One lazy-loaded Timeline page: the `limitDays` most recent days (strictly before `before`, when given),
// newest day first, each day's entries newest-first with a stable tie-break (the pure domain ordering).
// Bounding by DISTINCT days — not rows — keeps a chatty day from swallowing the page; an empty array
// means no more. Day keys are fixed-width `YYYY-MM-DD`, so a lexicographic `<` is an exact day compare.
export async function listTimelinePage(
  db: DbClient,
  userId: string,
  before: string | undefined,
  limitDays: number
): Promise<ReadonlyArray<TimelineDayDto>> {
  const all = await loadPersonalTimelineEntries(db, userId);
  const days = groupTimelineEntriesByDay(all);
  const filtered = before === undefined ? days : days.filter((day) => day.date < before);

  return filtered.slice(0, limitDays).map((day) => ({ date: day.date, entries: [...day.entries] }));
}

// The dates in `[from, to]` that have ≥1 ready diary entry for the user — the date-jump calendar's marks,
// derived from each entry's `occurred_at` (UTC day) rather than a stored day column. Distinct, ascending.
// Diary-scoped so the calendar marks land on the days the diary-filtered Timeline actually shows.
export async function listCalendarDates(
  db: DbClient,
  userId: string,
  from: string,
  to: string
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .select({ occurredAt: personalEntries.occurredAt })
    .from(diaryEntries)
    .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
    .where(and(eq(personalEntries.userId, userId), readyDiary()));

  const days = new Set(rows.map((row) => toDayKey(row.occurredAt)));
  return [...days].filter((day) => day >= from && day <= to).sort();
}

// Every diary Entry the user owns, newest first — the full-state read facet the write-side commands
// project after a write. Includes in-flight/failed voice captures (unlike the Timeline) so a caller can
// inspect the full diary state; scoped to the owner via `personal_entries`.
export async function listDiaryEntriesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<DiaryEntryDto>> {
  const rows = await db
    .select({
      bodyDoc: diaryEntries.bodyDoc,
      bodyText: diaryEntries.bodyText,
      createdAt: personalEntries.createdAt,
      entryId: diaryEntries.entryId,
      failureReason: diaryEntries.failureReason,
      inputMode: diaryEntries.inputMode,
      language: diaryEntries.language,
      occurredAt: personalEntries.occurredAt,
      processingStatus: diaryEntries.processingStatus,
      updatedAt: personalEntries.updatedAt
    })
    .from(diaryEntries)
    .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
    .where(eq(personalEntries.userId, userId))
    .orderBy(desc(personalEntries.occurredAt), asc(diaryEntries.entryId));

  return rows.map((row) => ({
    bodyDoc: row.bodyDoc as DocumentNodeJSON,
    bodyText: row.bodyText,
    createdAt: row.createdAt.toISOString(),
    failureReason: row.failureReason,
    id: row.entryId,
    inputMode: row.inputMode,
    language: row.language,
    occurredAt: row.occurredAt.toISOString(),
    processingStatus: row.processingStatus,
    updatedAt: row.updatedAt.toISOString()
  }));
}
