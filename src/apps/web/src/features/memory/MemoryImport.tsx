import { useRef, useState } from "react";

import { Button } from "../../shared/ui/Button";
import { importMemory, suggestGloss } from "./memoryApi";
import {
  draftsFromText,
  importableDrafts,
  mergeDraftsAt,
  removeDraftFrom,
  splitContextIn,
  toImportItems,
  undoSplitIn,
  updateDraftIn,
  type ImportDraft
} from "./memoryImportDrafts";

type MemoryImportProps = Readonly<{ onImported: () => void; onCancel: () => void }>;

type Phase = "paste" | "review";

const requestFailedMessage =
  "Could not import that list. Nothing was saved \u2014 your text is untouched, so you can try again.";

const noImportableMessage = "Add at least one term with a cue to import.";

// The "Paste a list" surface (#574): paste multiline plain text, preview the deterministic split into
// drafts, refine them (edit, undo a proposed split, merge adjacent, split a context out, remove, ask the
// offline dictionary for an answer), then import the whole batch atomically. The pure list edits live in
// memoryImportDrafts; this component only wires them to inputs and the import call. The original pasted
// text is preserved until the learner imports or cancels, and a failed import keeps every draft.
export function MemoryImport({ onImported, onCancel }: MemoryImportProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("paste");
  const [rawText, setRawText] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyArray<ImportDraft>>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);

  function makeId(): string {
    nextId.current += 1;
    return `draft-${nextId.current}`;
  }

  function preview(): void {
    setDrafts(draftsFromText(rawText, makeId));
    setPhase("review");
  }

  function backToPaste(): void {
    setError(null);
    setPhase("paste");
  }

  async function suggest(id: string, cue: string): Promise<void> {
    const term = cue.trim();
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
          : updateDraftIn(current, id, { answer: result.suggestion, note: null })
      );
    } catch {
      setError(requestFailedMessage);
    }
  }

  async function runImport(): Promise<void> {
    const items = toImportItems(drafts);
    if (items.length === 0) {
      setError(noImportableMessage);
      return;
    }

    setPending(true);
    setError(null);
    try {
      await importMemory({ items });
      onImported();
    } catch {
      setError(requestFailedMessage);
    } finally {
      setPending(false);
    }
  }

  const importableCount = importableDrafts(drafts).length;

  return (
    <section
      aria-label="Paste a list into memory"
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
            <Button onClick={onCancel} type="button" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Review the {drafts.length} drafts below. Edit anything, undo a split, merge or split
            rows, or remove a line. Terms without an answer save as unscheduled drafts.
          </p>
          <ol className="flex flex-col gap-3">
            {drafts.map((draft, index) => (
              <li
                className="flex flex-col gap-2 rounded border border-border bg-bg p-3"
                key={draft.id}
              >
                <label className="flex flex-col gap-1 text-sm text-text">
                  Cue
                  <input
                    className="rounded border border-border bg-surface px-2 py-1 text-text"
                    onChange={(event) =>
                      setDrafts((current) =>
                        updateDraftIn(current, draft.id, { cue: event.target.value })
                      )
                    }
                    value={draft.cue}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-text">
                  Answer
                  <input
                    className="rounded border border-border bg-surface px-2 py-1 text-text"
                    onChange={(event) =>
                      setDrafts((current) =>
                        updateDraftIn(current, draft.id, { answer: event.target.value })
                      )
                    }
                    value={draft.answer}
                  />
                </label>
                {draft.context.length > 0 ? (
                  <label className="flex flex-col gap-1 text-sm text-text">
                    Context
                    <textarea
                      className="rounded border border-border bg-surface px-2 py-1 text-text"
                      onChange={(event) =>
                        setDrafts((current) =>
                          updateDraftIn(current, draft.id, { context: event.target.value })
                        )
                      }
                      value={draft.context}
                    />
                  </label>
                ) : null}
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
                  {draft.answer.trim().length === 0 ? (
                    <Button
                      onClick={() => void suggest(draft.id, draft.cue)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Suggest answer
                    </Button>
                  ) : null}
                  {draft.context.length > 0 ? (
                    <Button
                      onClick={() =>
                        setDrafts((current) => splitContextIn(current, draft.id, makeId))
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Split off context
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
                {draft.note !== null ? (
                  <p className="text-sm text-text-muted">{draft.note}</p>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void runImport()} pending={pending} type="button">
              Import {importableCount}
            </Button>
            <Button onClick={backToPaste} type="button" variant="ghost">
              Back to paste
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
