import type { ImportNotesRequest } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import { documentReadableText } from "@whetstone/document";

import { insertCurrentNotePromptInTx, insertNoteInTx, type NotesDependencies } from "./noteCommands.js";

// One created note in an import result: its note Entry id and the id of the single cardless current-note
// prompt created under it, in pasted order.
export type ImportedNote = Readonly<{ noteEntryId: string; promptId: string }>;

export type ImportNotesResult = Readonly<{ imported: ReadonlyArray<ImportedNote> }>;

// Import a batch of refined notebook rows as standalone Notes (#661) in ONE atomic write — the canonical
// Notes-owned import writer. Every row is prepared first (ids minted, readable text derived server-side
// from each rich document, never trusted from the client), THEN a single transaction creates, per row,
// exactly one `capture_source = 'import'` standalone note (its `body_doc` = the edited Note document) and
// exactly one cardless current-note prompt (its cue = the edited Question document), linked note→prompt.
// It writes NO answer copy, NO `memory_notes` row, NO review card, and NO review event: an imported note
// enters Review only when the learner deliberately adds it (reusing that same prompt). Either every row
// lands or none does — any failure rolls the whole transaction back, leaving Notes untouched. Returns the
// created note/prompt ids in pasted order so the UI can report "Imported N notes" and focus the first.
export async function importNotesBatch(
  dependencies: NotesDependencies,
  items: ImportNotesRequest["items"],
  userId: string
): Promise<ImportNotesResult> {
  const now = dependencies.now();

  const prepared = items.map((item) => ({
    noteDoc: item.noteDoc,
    noteEntryId: toEntryId(dependencies.createEntryId()),
    noteText: documentReadableText(item.noteDoc),
    promptId: dependencies.createEntryId(),
    questionDoc: item.questionDoc,
    questionText: documentReadableText(item.questionDoc)
  }));

  await dependencies.db.transaction(async (tx) => {
    for (const row of prepared) {
      await insertNoteInTx(tx, {
        anchor: null,
        bodyDoc: row.noteDoc,
        bodyText: row.noteText,
        captureSource: "import",
        kind: "note",
        noteEntryId: row.noteEntryId,
        now,
        userId
      });
      await insertCurrentNotePromptInTx(tx, {
        cueDoc: row.questionDoc,
        cueText: row.questionText,
        noteEntryId: row.noteEntryId,
        now,
        promptId: row.promptId
      });
    }
  });

  return {
    imported: prepared.map((row) => ({ noteEntryId: row.noteEntryId, promptId: row.promptId }))
  };
}
