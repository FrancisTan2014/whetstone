import type { DiaryEntryDto, TimelineDayDto, TimelineEntryDto } from "@whetstone/contracts";
import { groupTimelineEntriesByDay } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  diaryEntries,
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

// The current user's personal Entries as discriminated Timeline rows (diary + note + work + recitation): a
// `diary` row carries its rich body, a `note` row its readable body plus how it was captured and how many
// Memory prompts depend on it (a Reader note and a former Memory note are the same `note` row, #620). All
// draw chronology from the shared `personal_entries` facet. Combined here (unordered); the pure domain
// `groupTimelineEntriesByDay` orders and buckets them deterministically, so no Timeline-only entity exists.
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
      captureSource: notes.captureSource,
      entryId: notes.entryId,
      occurredAt: personalEntries.occurredAt,
      text: notes.bodyText
    })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .where(and(eq(personalEntries.userId, userId), eq(notes.kind, "note")));
  // A note's Memory prompts are dependent behavior, not Timeline rows (#620): count them per note so the
  // row shows how many retrieval prompts depend on it (0 for a Reader note or an unprompted Memory note).
  // One grouped read over all the user's notes; each note itself already appears once via personal_entries,
  // so a former Memory note and a Reader note surface the same way — a single `note` row.
  const noteIds = noteRows.map((row) => row.entryId);
  const promptCounts =
    noteIds.length === 0
      ? []
      : await db
          .select({ noteEntryId: memoryPrompts.noteEntryId, total: count() })
          .from(memoryPrompts)
          .where(inArray(memoryPrompts.noteEntryId, noteIds))
          .groupBy(memoryPrompts.noteEntryId);
  const promptCountByNote = new Map(
    promptCounts.map((row) => [row.noteEntryId, Number(row.total)])
  );

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

  const diaryTimeline: ReadonlyArray<TimelineEntryDto> = diaryRows.map((row) => ({
    bodyDoc: row.bodyDoc as DocumentNodeJSON,
    bodyText: row.bodyText,
    entryId: row.entryId,
    kind: "diary",
    language: row.language,
    occurredAt: row.occurredAt.toISOString()
  }));
  const noteTimeline: ReadonlyArray<TimelineEntryDto> = noteRows.map((row) => ({
    captureSource: row.captureSource,
    entryId: row.entryId,
    kind: "note",
    occurredAt: row.occurredAt.toISOString(),
    promptCount: promptCountByNote.get(row.entryId) ?? 0,
    // `body_text` is non-null for a `kind = 'note'` row (the DB check constraint guarantees it), and the
    // query filters to notes, so the readable body is always present here.
    text: row.text as string
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

  return [...diaryTimeline, ...noteTimeline, ...workTimeline, ...recitationTimeline];
}

// One lazy-loaded Timeline page: the `limitDays` most recent days (strictly before `before`, when given),
// newest day first, each day's entries newest-first with a stable tie-break (the pure domain ordering).
// Bounding by DISTINCT days — not rows — keeps a chatty day from swallowing the page; an empty array
// means no more. Day keys are fixed-width `YYYY-MM-DD`, so a lexicographic `<` is an exact day compare.
export async function listTimelinePage(
  db: DbClient,
  userId: string,
  before: string | undefined,
  limitDays: number,
  timeZone: string
): Promise<ReadonlyArray<TimelineDayDto>> {
  const all = await loadPersonalTimelineEntries(db, userId);
  const days = groupTimelineEntriesByDay(all, timeZone);
  const filtered = before === undefined ? days : days.filter((day) => day.date < before);

  return filtered.slice(0, limitDays).map((day) => ({ date: day.date, entries: [...day.entries] }));
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
    id: row.entryId,
    inputMode: row.inputMode,
    language: row.language,
    occurredAt: row.occurredAt.toISOString(),
    processingStatus: row.processingStatus,
    updatedAt: row.updatedAt.toISOString()
  }));
}
