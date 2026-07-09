import type { DiaryEntryDto } from "@whetstone/contracts";
import { toDayKey } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, timelineEntries } from "../../db/schema.js";
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
  rawInputText: string;
  tidiedText: string | null;
}>;

// The Diary is a filtered view over the shared Timeline store (#559): a diary entry is a
// `timeline_entries` row with `capture_source = "diary"`. Its displayed text is the tidied form, falling
// back to the verbatim raw transcript when tidy has not (or could not) run — the same projection every
// diary read uses, so create/read/edit agree.
function toDiaryEntryDto(row: DiaryRow): DiaryEntryDto {
  return {
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    id: row.id,
    language: row.language,
    text: row.tidiedText ?? row.rawInputText
  };
}

// Capture an entry: tidy the transcript (the LLM seam), then persist it onto the Timeline as a
// diary-sourced voice capture filed under today for the current user. The raw transcript is preserved
// verbatim in `raw_input_text` and the tidy-pass result in `tidied_text`. Registering the owning Entry
// (`type = "timeline_entry"`) and the capture row in one transaction keeps a capture from ever existing
// without its Entry. The server owns `entry_date` (today, from `now`) and `created_at` (`now`) so the
// client cannot backdate or forge a day. Language is unknown in v0 and stored null.
export async function createDiaryEntry(
  dependencies: DiaryDependencies,
  transcript: string,
  userId: string,
  now: Date
): Promise<DiaryEntryDto> {
  const tidied = await dependencies.tidy(transcript);
  const entryId = dependencies.createId();
  const row = {
    entryId,
    userId,
    createdAt: now,
    entryDate: toDayKey(now),
    inputMode: "voice" as const,
    captureSource: "diary" as const,
    rawInputText: transcript,
    tidiedText: tidied,
    language: null,
    rawAudioPath: null
  } as const;

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "timeline_entry" });
    await tx.insert(timelineEntries).values(row);
  });

  return toDiaryEntryDto({
    createdAt: now,
    entryDate: row.entryDate,
    id: entryId,
    language: null,
    rawInputText: transcript,
    tidiedText: tidied
  });
}

// Edit an entry's tidied text. Scoped to the current user AND to diary-sourced captures, so a forged id,
// another user's entry, or a non-diary Timeline capture (a Quick Capture) is rejected (404); the entry's
// date/timestamp are fixed at capture (not editable here).
export async function updateDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  text: string,
  userId: string
): Promise<UpdateDiaryEntryResult> {
  const updated = await dependencies.db
    .update(timelineEntries)
    .set({ tidiedText: text })
    .where(
      and(
        eq(timelineEntries.entryId, id),
        eq(timelineEntries.userId, userId),
        eq(timelineEntries.captureSource, "diary")
      )
    )
    .returning({
      createdAt: timelineEntries.createdAt,
      entryDate: timelineEntries.entryDate,
      id: timelineEntries.entryId,
      language: timelineEntries.language,
      rawInputText: timelineEntries.rawInputText,
      tidiedText: timelineEntries.tidiedText
    });
  const row = updated[0];

  if (row === undefined) {
    return { status: "not_found" };
  }

  return { entry: toDiaryEntryDto(row), status: "updated" };
}

// Delete an entry: remove the diary-sourced Timeline row and its owning Entry (the timeline row
// references the Entry, so it is removed first). Scoped to the current user AND diary source, so a forged
// id, another user's entry, or a non-diary capture deletes nothing (404). Run in one transaction so the
// capture and its Entry are removed together.
export async function deleteDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  userId: string
): Promise<DeleteDiaryEntryResult> {
  return dependencies.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(timelineEntries)
      .where(
        and(
          eq(timelineEntries.entryId, id),
          eq(timelineEntries.userId, userId),
          eq(timelineEntries.captureSource, "diary")
        )
      )
      .returning({ id: timelineEntries.entryId });

    if (deleted.length === 0) {
      return { status: "not_found" };
    }

    await tx.delete(entries).where(eq(entries.id, id));

    return { status: "deleted" };
  });
}
