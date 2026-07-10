import type { CaptureInputMode, CaptureLanguage, DiaryEntryDto } from "@whetstone/contracts";
import { createTextDocument, documentText, type DocumentNodeJSON } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { diaryEntries, entries, personalEntries } from "../../db/schema.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the diary commands stay
// deterministic and testable. A diary capture journals only (#571): there is no tidy or proposal seam on
// this synchronous path — the durable body is built from the captured text and saved immediately.
export type DiaryDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type UpdateDiaryEntryResult =
  | Readonly<{ entry: DiaryEntryDto; status: "updated" }>
  | Readonly<{ status: "not_found" }>;

export type DeleteDiaryEntryResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "not_found" }>;

// Capture a diary Entry, save-first (#571): the durable ProseMirror/Tiptap body is built from the typed
// text and persisted BEFORE returning — a typed capture is ready immediately (`processing_status` null),
// with no asynchronous tidy or transcription in the path. Three rows are written in one transaction so a
// capture never exists without its identity: the owning `entries` row (`type = "diary_entry"`), the
// shared `personal_entries` ownership+chronology facet (owner + occurredAt/createdAt/updatedAt, all
// `now`, server-owned so the client cannot backdate a day), and the diary-specific `diary_entries` facet
// (the body doc + its plaintext projection, the input mode, and the verbatim transcript). `raw_transcript`
// preserves the captured text; `tidied_text` is null on the synchronous path (tidy is a voice-only step).
export async function createDiaryEntry(
  dependencies: DiaryDependencies,
  transcript: string,
  inputMode: CaptureInputMode,
  language: CaptureLanguage,
  userId: string,
  now: Date
): Promise<DiaryEntryDto> {
  const entryId = dependencies.createId();
  const bodyDoc = createTextDocument(transcript);
  const bodyText = documentText(bodyDoc);

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "diary_entry" });
    await tx
      .insert(personalEntries)
      .values({ createdAt: now, entryId, occurredAt: now, updatedAt: now, userId });
    await tx.insert(diaryEntries).values({
      bodyDoc,
      bodyText,
      entryId,
      failureReason: null,
      inputMode,
      language,
      processingStatus: null,
      rawAudioPath: null,
      rawTranscript: transcript,
      tidiedText: null
    });
  });

  const iso = now.toISOString();
  return {
    bodyDoc,
    bodyText,
    createdAt: iso,
    failureReason: null,
    id: entryId,
    inputMode,
    language,
    occurredAt: iso,
    processingStatus: null,
    updatedAt: iso
  };
}

// Edit a diary Entry's rich body through the shared editor: replace `body_doc` (and its plaintext
// projection `body_text`), optionally the language, and bump `updated_at` to `now`; occurredAt/createdAt
// are fixed at capture. Scoped to the owner: a forged id, another user's entry, or a non-diary personal
// Entry (a note shares `personal_entries` but has no `diary_entries` row) is rejected (404). The
// ownership check and the writes run in one transaction so an edit never lands on an unowned row.
export async function updateDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  bodyDoc: DocumentNodeJSON,
  language: CaptureLanguage | null | undefined,
  userId: string
): Promise<UpdateDiaryEntryResult> {
  const now = dependencies.now();

  return dependencies.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({
        createdAt: personalEntries.createdAt,
        failureReason: diaryEntries.failureReason,
        inputMode: diaryEntries.inputMode,
        language: diaryEntries.language,
        occurredAt: personalEntries.occurredAt,
        processingStatus: diaryEntries.processingStatus
      })
      .from(diaryEntries)
      .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
      .where(and(eq(diaryEntries.entryId, id), eq(personalEntries.userId, userId)))
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" };
    }

    const bodyText = documentText(bodyDoc);
    const nextLanguage = language === undefined ? owned.language : language;
    await tx
      .update(diaryEntries)
      .set(language === undefined ? { bodyDoc, bodyText } : { bodyDoc, bodyText, language })
      .where(eq(diaryEntries.entryId, id));
    await tx.update(personalEntries).set({ updatedAt: now }).where(eq(personalEntries.entryId, id));

    return {
      entry: {
        bodyDoc,
        bodyText,
        createdAt: owned.createdAt.toISOString(),
        failureReason: owned.failureReason,
        id,
        inputMode: owned.inputMode,
        language: nextLanguage,
        occurredAt: owned.occurredAt.toISOString(),
        processingStatus: owned.processingStatus,
        updatedAt: now.toISOString()
      },
      status: "updated"
    };
  });
}

// Delete a diary Entry: remove its diary facet, its personal-entry facet, and the owning Entry in one
// transaction. Scoped to the owner via `personal_entries`, so a forged id, another user's entry, or a
// non-diary personal Entry deletes nothing (404).
export async function deleteDiaryEntry(
  dependencies: DiaryDependencies,
  id: string,
  userId: string
): Promise<DeleteDiaryEntryResult> {
  return dependencies.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ entryId: diaryEntries.entryId })
      .from(diaryEntries)
      .innerJoin(personalEntries, eq(personalEntries.entryId, diaryEntries.entryId))
      .where(and(eq(diaryEntries.entryId, id), eq(personalEntries.userId, userId)))
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" };
    }

    await tx.delete(diaryEntries).where(eq(diaryEntries.entryId, id));
    await tx.delete(personalEntries).where(eq(personalEntries.entryId, id));
    await tx.delete(entries).where(eq(entries.id, id));

    return { status: "deleted" };
  });
}
