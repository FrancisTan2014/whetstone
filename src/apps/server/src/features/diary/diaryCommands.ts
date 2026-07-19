import type { CaptureLanguage, DiaryEntryDto } from "@whetstone/contracts";
import { documentReadableText, type DocumentNodeJSON } from "@whetstone/document";
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

// Capture a typed diary Entry, save-first (#571): the durable ProseMirror/Tiptap body is the exact
// canonical document the learner authored in the shared editor — it crosses the boundary intact, never
// flattened to plaintext and rebuilt (#678) — and is persisted BEFORE returning, so a typed capture is
// ready immediately (`processing_status` null) with no asynchronous tidy or transcription in the path.
// The server owns the facts the client must not: `inputMode` is fixed to `typed` here (not trusted from
// the request), and occurredAt/createdAt/updatedAt are all `now` (server-owned so the client cannot
// backdate a day). No capture language is chosen for typed capture, so `language` is null (#647). Three
// rows are written in one transaction so a capture never exists without its identity: the owning
// `entries` row (`type = "diary_entry"`), the shared `personal_entries` ownership+chronology facet, and
// the diary-specific `diary_entries` facet (the body doc + its readable-text projection). `raw_transcript`
// is null: the canonical `bodyDoc` IS the raw user input, so no second transcript copy is kept (legacy
// typed rows retain whatever transcript they were written with); `tidied_text` is null (tidy is a
// voice-only step).
export async function createDiaryEntry(
  dependencies: DiaryDependencies,
  bodyDoc: DocumentNodeJSON,
  userId: string,
  now: Date
): Promise<DiaryEntryDto> {
  const entryId = dependencies.createId();
  const bodyText = documentReadableText(bodyDoc);

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
      inputMode: "typed",
      language: null,
      processingStatus: null,
      rawAudioPath: null,
      rawTranscript: null,
      tidiedText: null
    });
  });

  const iso = now.toISOString();
  return {
    bodyDoc,
    bodyText,
    createdAt: iso,
    id: entryId,
    inputMode: "typed",
    language: null,
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

    const bodyText = documentReadableText(bodyDoc);
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
