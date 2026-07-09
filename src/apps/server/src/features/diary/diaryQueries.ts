import type { DiaryEntryDto, TimelineDayDto } from "@whetstone/contracts";
import { groupByDayDesc } from "@whetstone/domain";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { timelineEntries } from "../../db/schema.js";

// The Diary reads the shared Timeline store filtered to diary-sourced captures (#559): every diary read
// scopes to the current user AND `capture_source = "diary"`, so a Quick Capture never surfaces in the
// Diary. The displayed text is the tidied form, falling back to the verbatim raw transcript when tidy has
// not run (null), matching the create/edit projection.
const diarySource = "diary" as const;

// A diary read only surfaces entries ready to display: a synchronous capture (status null — typed diary /
// legacy) or a voice capture the worker has finished (`ready`). An in-flight or failed async voice capture
// (#565) — queued/transcribing/tidying/failed — is NOT shown in the Timeline/calendar (its transcript is
// empty or absent); the frontend polls the voice-capture status endpoint for those instead.
function diaryScope(userId: string) {
  return and(
    eq(timelineEntries.userId, userId),
    eq(timelineEntries.captureSource, diarySource),
    or(isNull(timelineEntries.processingStatus), eq(timelineEntries.processingStatus, "ready"))
  );
}

// One timeline row enriched with its day key, ready for `groupByDayDesc`.
type TimelineRow = Readonly<{
  createdAt: string;
  date: string;
  id: string;
  kind: "diary";
  language: string | null;
  text: string;
}>;

// One lazy-loaded Timeline page: the `limitDays` most recent days (strictly before `before`, when given),
// newest day first, each with its entries (oldest-first within a day, by `groupByDayDesc`). Bounding by
// DISTINCT days — not rows — keeps a chatty day from swallowing the page; an empty array means no more.
export async function listTimelinePage(
  db: DbClient,
  userId: string,
  before: string | undefined,
  limitDays: number
): Promise<ReadonlyArray<TimelineDayDto>> {
  // `before` is an exclusive cursor: the next page is the days STRICTLY before it (the oldest day already
  // shown), so a same-day row never repeats across pages. Day keys are fixed-width `YYYY-MM-DD`, so a
  // lexicographic `<` is an exact day comparison.
  const scope = diaryScope(userId);
  const dayFilter =
    before === undefined ? scope : and(scope, lt(timelineEntries.entryDate, before));

  const dayRows = await db
    .selectDistinct({ entryDate: timelineEntries.entryDate })
    .from(timelineEntries)
    .where(dayFilter)
    .orderBy(desc(timelineEntries.entryDate))
    .limit(limitDays);
  const dates = dayRows.map((row) => row.entryDate);

  if (dates.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      createdAt: timelineEntries.createdAt,
      entryDate: timelineEntries.entryDate,
      id: timelineEntries.entryId,
      language: timelineEntries.language,
      rawInputText: timelineEntries.rawInputText,
      tidiedText: timelineEntries.tidiedText
    })
    .from(timelineEntries)
    .where(and(scope, inArray(timelineEntries.entryDate, dates)));

  const timelineRows: ReadonlyArray<TimelineRow> = rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    date: row.entryDate,
    id: row.id,
    kind: "diary",
    language: row.language,
    text: row.tidiedText ?? row.rawInputText
  }));

  return groupByDayDesc(timelineRows).map((group) => ({
    date: group.date,
    entries: group.entries.map(({ createdAt, id, kind, language, text }) => ({
      createdAt,
      id,
      kind,
      language,
      text
    }))
  }));
}

// The dates in `[from, to]` that have ≥1 diary entry for the user — the date-jump calendar's marks.
// Distinct, ascending.
export async function listCalendarDates(
  db: DbClient,
  userId: string,
  from: string,
  to: string
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .selectDistinct({ entryDate: timelineEntries.entryDate })
    .from(timelineEntries)
    .where(
      and(
        diaryScope(userId),
        gte(timelineEntries.entryDate, from),
        lte(timelineEntries.entryDate, to)
      )
    )
    .orderBy(asc(timelineEntries.entryDate));

  return rows.map((row) => row.entryDate);
}

// Every diary entry the user owns — the coach-readable learner-history facet for diary capture, queried
// for the user (newest first). Scoped to diary-sourced captures so a Quick Capture never appears here.
export async function listDiaryEntriesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<DiaryEntryDto>> {
  const rows = await db
    .select({
      createdAt: timelineEntries.createdAt,
      entryDate: timelineEntries.entryDate,
      id: timelineEntries.entryId,
      language: timelineEntries.language,
      rawInputText: timelineEntries.rawInputText,
      tidiedText: timelineEntries.tidiedText
    })
    .from(timelineEntries)
    .where(diaryScope(userId))
    .orderBy(desc(timelineEntries.createdAt));

  return rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    id: row.id,
    language: row.language,
    text: row.tidiedText ?? row.rawInputText
  }));
}
