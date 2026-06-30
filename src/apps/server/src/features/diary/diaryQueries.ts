import type { DiaryEntryDto, TimelineDayDto } from "@whetstone/contracts";
import { groupByDayDesc } from "@whetstone/domain";
import { and, asc, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { diaryEntries } from "../../db/schema.js";

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
  const dayFilter =
    before === undefined
      ? eq(diaryEntries.userId, userId)
      : and(eq(diaryEntries.userId, userId), lt(diaryEntries.entryDate, before));

  const dayRows = await db
    .selectDistinct({ entryDate: diaryEntries.entryDate })
    .from(diaryEntries)
    .where(dayFilter)
    .orderBy(desc(diaryEntries.entryDate))
    .limit(limitDays);
  const dates = dayRows.map((row) => row.entryDate);

  if (dates.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      createdAt: diaryEntries.createdAt,
      entryDate: diaryEntries.entryDate,
      id: diaryEntries.id,
      language: diaryEntries.language,
      text: diaryEntries.text
    })
    .from(diaryEntries)
    .where(and(eq(diaryEntries.userId, userId), inArray(diaryEntries.entryDate, dates)));

  const timelineRows: ReadonlyArray<TimelineRow> = rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    date: row.entryDate,
    id: row.id,
    kind: "diary",
    language: row.language,
    text: row.text
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

// The dates in `[from, to]` that have ≥1 entry for the user — the date-jump calendar's marks. Distinct,
// ascending.
export async function listCalendarDates(
  db: DbClient,
  userId: string,
  from: string,
  to: string
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .selectDistinct({ entryDate: diaryEntries.entryDate })
    .from(diaryEntries)
    .where(
      and(
        eq(diaryEntries.userId, userId),
        gte(diaryEntries.entryDate, from),
        lte(diaryEntries.entryDate, to)
      )
    )
    .orderBy(asc(diaryEntries.entryDate));

  return rows.map((row) => row.entryDate);
}

// Every diary entry the user owns — the coach-readable learner-history facet for diary capture, queried
// for the user (newest first). Used to prove capture deposits into the learner history the coach reads.
export async function listDiaryEntriesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<DiaryEntryDto>> {
  const rows = await db
    .select({
      createdAt: diaryEntries.createdAt,
      entryDate: diaryEntries.entryDate,
      id: diaryEntries.id,
      language: diaryEntries.language,
      text: diaryEntries.text
    })
    .from(diaryEntries)
    .where(eq(diaryEntries.userId, userId))
    .orderBy(desc(diaryEntries.createdAt));

  return rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    id: row.id,
    language: row.language,
    text: row.text
  }));
}
