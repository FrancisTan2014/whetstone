import type { DiaryEntryDto } from "@whetstone/contracts";
import { toDayKey } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { diaryEntries } from "../../db/schema.js";
import type { DiaryTidy } from "./diaryTidy.js";

// Real infrastructure boundaries (db, id generation, the tidy seam) are injected so the diary commands
// stay deterministic and testable; the LLM call is faked in tests via `tidy`.
export type DiaryDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
  tidy: DiaryTidy;
}>;

export type UpdateDiaryEntryResult =
  | Readonly<{ entry: DiaryEntryDto; status: "updated" }>
  | Readonly<{ status: "not_found" }>;

export type DeleteDiaryEntryResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "not_found" }>;

type DiaryRow = Readonly<{
  createdAt: Date;
  entryDate: string;
  id: string;
  language: string | null;
  text: string;
}>;

function toDiaryEntryDto(row: DiaryRow): DiaryEntryDto {
  return {
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    id: row.id,
    language: row.language,
    text: row.text
  };
}

// Capture an entry: tidy the transcript (the LLM seam), then persist it as a dated block under today for
// the current user. The server owns `entry_date` (today, from `now`) and `created_at` (`now`) so the
// client cannot backdate or forge a day. Language is unknown in v0 and stored null.
export async function createDiaryEntry(
  dependencies: DiaryDependencies,
  transcript: string,
  userId: string,
  now: Date
): Promise<DiaryEntryDto> {
  const text = await dependencies.tidy(transcript);
  const row = {
    createdAt: now,
    entryDate: toDayKey(now),
    id: dependencies.createId(),
    language: null,
    text,
    userId
  } as const;

  await dependencies.db.insert(diaryEntries).values(row);

  return toDiaryEntryDto(row);
}

// Edit an entry's tidied text. Scoped to the current user so a forged or another user's id is rejected
// (404), and the entry's date/timestamp are fixed at capture (not editable here).
export async function updateDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  text: string,
  userId: string
): Promise<UpdateDiaryEntryResult> {
  const updated = await dependencies.db
    .update(diaryEntries)
    .set({ text })
    .where(and(eq(diaryEntries.id, id), eq(diaryEntries.userId, userId)))
    .returning({
      createdAt: diaryEntries.createdAt,
      entryDate: diaryEntries.entryDate,
      id: diaryEntries.id,
      language: diaryEntries.language,
      text: diaryEntries.text
    });
  const row = updated[0];

  if (row === undefined) {
    return { status: "not_found" };
  }

  return { entry: toDiaryEntryDto(row), status: "updated" };
}

// Delete an entry. Scoped to the current user so a forged or another user's id deletes nothing (404).
export async function deleteDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  userId: string
): Promise<DeleteDiaryEntryResult> {
  const deleted = await dependencies.db
    .delete(diaryEntries)
    .where(and(eq(diaryEntries.id, id), eq(diaryEntries.userId, userId)))
    .returning({ id: diaryEntries.id });

  return deleted.length === 0 ? { status: "not_found" } : { status: "deleted" };
}
