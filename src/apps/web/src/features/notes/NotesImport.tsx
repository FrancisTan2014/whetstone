import { useRef, useState } from "react";

import type { ImportNotesResultDto } from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";

import { RichContentEditor } from "../../shared/editor";
import { Button } from "../../shared/ui/Button";
import { importNotes, suggestGloss } from "./notesApi";
import {
  draftsFromText,
  importableNoteDrafts,
  incompleteNoteDrafts,
  mergeDraftsAt,
  noteHasSplittableContext,
  removeDraftFrom,
  splitContextIn,
  toImportNoteItems,
  undoSplitIn,
  updateDraftIn,
  type NoteImportDraft
} from "./notesImportDrafts";

type NotesImportProps = Readonly<{
  onImported: (result: ImportNotesResultDto) => void;
  onCancel: () => void;
}>;

type Phase = "paste" | "review";

const requestFailedMessage =
  "Could not import that list. Nothing was saved \u2014 your text is untouched, so you can try again.";

const incompleteMessage =
  "Give every row a question and a note, or remove it, before importing.";

const discardConfirmMessage = "Discard this import? Your edits will be lost.";

// The Notes "Import a list" surface (#661): paste multiline plain text, preview the deterministic split
// into Question/Note rows, refine them (edit either field, undo a proposed split, merge adjacent, split a
// row out, remove, or fill a blank note from the offline dictionary), then import the whole batch
// atomically as standalone Notes. Import is another Notes writer — each row's parsed answer and context are
// folded into ONE Note document, and every remaining row must carry a non-blank Question AND Note before it
// can land (incomplete rows are flagged inline, never silently dropped). The pure list edits live in
// notesImportDrafts; this component only wires them to inputs and the import call. The original pasted text
// survives until the learner imports or cancels, a failed import keeps every draft, and cancel confirms
// before discarding unsaved edits.
export function NotesImport({ onImported, onCancel }: NotesImportProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("paste");
  const [rawText, setRawText] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyArray<NoteImportDraft>>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);

  function makeId(): string {
    nextId.current += 1;
    return `note-draft-${nextId.current}`;
  }

  function preview(): void {
    setDrafts(draftsFromText(rawText, makeId));
    setPhase("review");
  }

  function backToPaste(): void {
    setError(null);
    setPhase("paste");
  }

  function cancel(): void {
    const hasEdits = rawText.trim().length > 0 || drafts.length > 0;
    if (hasEdits && !window.confirm(discardConfirmMessage)) {
      return;
    }
    onCancel();
  }

  async function suggest(id: string, question: string): Promise<void> {
    const term = question.trim();
    if (term.length === 0) {
      return;
    }
    setError(null);
    try {
      const result = await suggestGloss(term);
      setDrafts((current) =>
        result.suggestion === null
          ? updateDraftIn(current, id, {
              note: `No dictionary suggestion for \u201c${term}\u201d.`
            })
          : updateDraftIn(current, id, {
              noteDoc: createTextDocument(result.suggestion),
              note: null
            })
      );
    } catch {
      setError(requestFailedMessage);
    }
  }

  async function runImport(): Promise<void> {
    if (incompleteNoteDrafts(drafts).length > 0) {
      setError(incompleteMessage);
      return;
    }
    const items = toImportNoteItems(drafts);
    if (items.length === 0) {
      setError(incompleteMessage);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const result = await importNotes({ items });
      onImported(result);
    } catch {
      setError(requestFailedMessage);
    } finally {
      setPending(false);
    }
  }

  const importableCount = importableNoteDrafts(drafts).length;
  const incompleteCount = incompleteNoteDrafts(drafts).length;

  return (
    <section
      aria-label="Import a list into notes"
      className="rounded border border-border bg-surface p-4"
    >
      {phase === "paste" ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-text">
            Paste your list
            <textarea
              className="min-h-40 rounded border border-border bg-bg px-2 py-1 font-mono text-text"
              onChange={(event) => setRawText(event.target.value)}
              placeholder={"per = each\npush back -> pushback\n    resisted the plan\nserendipity"}
              value={rawText}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={rawText.trim().length === 0} onClick={preview} type="button">
              Preview
            </Button>
            <Button onClick={cancel} type="button" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Review the {drafts.length} rows below. Edit anything, undo a split, merge or split rows,
            or remove a line. Every row needs a question and a note before you can import.
          </p>
          <ol className="flex flex-col gap-3">
            {drafts.map((draft, index) => {
              const questionBlank = documentText(draft.questionDoc).trim().length === 0;
              const noteBlank = documentText(draft.noteDoc).trim().length === 0;
              return (
                <li
                  className="flex flex-col gap-2 rounded border border-border bg-bg p-3"
                  key={draft.id}
                >
                  <label className="flex flex-col gap-1 text-sm text-text">
                    Question
                    <RichContentEditor
                      ariaLabel="Question"
                      document={draft.questionDoc}
                      onChange={(document) =>
                        setDrafts((current) =>
                          updateDraftIn(current, draft.id, { questionDoc: document })
                        )
                      }
                      presentation="compact"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-text">
                    Note
                    <RichContentEditor
                      ariaLabel="Note"
                      document={draft.noteDoc}
                      onChange={(document) =>
                        setDrafts((current) =>
                          updateDraftIn(current, draft.id, { noteDoc: document })
                        )
                      }
                      presentation="compact"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    {draft.separator !== null ? (
                      <Button
                        onClick={() => setDrafts((current) => undoSplitIn(current, draft.id))}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Undo split
                      </Button>
                    ) : null}
                    {noteBlank ? (
                      <Button
                        onClick={() => void suggest(draft.id, documentText(draft.questionDoc))}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Suggest note
                      </Button>
                    ) : null}
                    {noteHasSplittableContext(draft) ? (
                      <Button
                        onClick={() =>
                          setDrafts((current) => splitContextIn(current, draft.id, makeId))
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Split off
                      </Button>
                    ) : null}
                    {index < drafts.length - 1 ? (
                      <Button
                        onClick={() => setDrafts((current) => mergeDraftsAt(current, index))}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Merge with next
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => setDrafts((current) => removeDraftFrom(current, draft.id))}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                  {questionBlank || noteBlank ? (
                    <p className="text-sm text-danger" role="alert">
                      {questionBlank && noteBlank
                        ? "Add a question and a note, or remove this row."
                        : questionBlank
                          ? "Add a question, or remove this row."
                          : "Add a note, or remove this row."}
                    </p>
                  ) : null}
                  {draft.note !== null ? (
                    <p className="text-sm text-text-muted">{draft.note}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={incompleteCount > 0 || importableCount === 0}
              onClick={() => void runImport()}
              pending={pending}
              type="button"
            >
              Import {importableCount}
            </Button>
            <Button onClick={backToPaste} type="button" variant="ghost">
              Back to paste
            </Button>
            <Button onClick={cancel} type="button" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error !== null ? (
        <p className="mt-3 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
