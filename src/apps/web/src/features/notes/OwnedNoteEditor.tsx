import { useState } from "react";

import { type NoteDto, type NoteOverviewDto } from "@whetstone/contracts";
import { documentText, type DocumentNodeJSON } from "@whetstone/document";

import { RichContentEditor } from "../../shared/editor/index.js";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button, buttonVariants } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";
import { createStandaloneNote, deleteOwnedNote, updateOwnedNote } from "./notesApi";
import { OwnedNoteReviewSection } from "./OwnedNoteReviewSection";

// The Notes-home editor opens either to create a standalone note (empty body, no source) or to edit an
// existing owned note. Marks are never routed here — they carry no body and no review action.
export type OwnedNoteEditorTarget =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "edit"; note: NoteOverviewDto }>;

type OwnedNoteEditorProps = Readonly<{
  onClose: () => void;
  onDeleted: (noteEntryId: string) => void;
  onSaved: (note: NoteDto) => void;
  target: OwnedNoteEditorTarget;
}>;

function initialBodyFor(target: OwnedNoteEditorTarget): DocumentNodeJSON {
  // A new standalone note starts empty; an edited note always carries a canonical body (a Mark, which has
  // none, never opens this editor), so the cast is sound.
  return target.kind === "create"
    ? createEmptyDocument()
    : (target.note.bodyDoc as DocumentNodeJSON);
}

// The Notes-home note editor (#659), hosted in the shared wide `Sheet`. It reuses the SAME
// `RichContentEditor` as the Reader so a note is authored in one place, and writes through the owner-scoped
// Notes commands so a standalone note and an anchored note edit identically. Creating writes a standalone
// note (empty body, no source section); editing shows an anchored note's immutable source as read-only
// context with an "Open in Reader" deep-link (the anchor offsets never change on edit) and the owner-scoped
// Review controls. Delete requires a named confirmation and runs the atomic cascade. A blank body blocks
// save; a failed save or delete surfaces an alert and never blanks the note.
export function OwnedNoteEditor({
  onClose,
  onDeleted,
  onSaved,
  target
}: OwnedNoteEditorProps): React.JSX.Element {
  // Keep the editor's initial document stable for this target's lifetime: `RichContentEditor` treats
  // `document` as authoritative and resets on identity change, and create-mode `initialBodyFor` mints a
  // fresh empty doc each render. The parent keys this component per target, so a new target remounts fresh.
  const [initialBody] = useState<DocumentNodeJSON>(() => initialBodyFor(target));
  const [draft, setDraft] = useState<DocumentNodeJSON>(initialBody);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const heading = target.kind === "create" ? "New note" : "Edit note";
  const blank = documentText(draft).trim().length === 0;
  const anchor = target.kind === "edit" ? target.note.anchor : null;

  async function persist(): Promise<NoteDto> {
    if (target.kind === "create") {
      return createStandaloneNote({ bodyDoc: draft });
    }

    return updateOwnedNote(target.note.entryId, { bodyDoc: draft });
  }

  async function onSave(): Promise<void> {
    if (blank) {
      setError("Write something before saving the note.");
      return;
    }

    let saved: NoteDto;

    setError(undefined);
    setSaving(true);

    try {
      saved = await persist();
    } catch {
      setError("Could not save the note. Please try again.");
      return;
    } finally {
      setSaving(false);
    }

    onSaved(saved);
  }

  function onConfirmDelete(): void {
    if (target.kind !== "edit") {
      return;
    }

    const { entryId } = target.note;
    setError(undefined);
    setDeleting(true);
    deleteOwnedNote(entryId).then(
      () => {
        setDeleting(false);
        onDeleted(entryId);
      },
      () => {
        setDeleting(false);
        setError("Could not delete the note. Please try again.");
      }
    );
  }

  return (
    <Sheet onOpenChange={onClose} open size="wide" title={heading}>
      <div className="noteEditor">
        {anchor !== null ? (
          <div className="noteEditorSource">
            <p className="noteEditorSelection">Source: “{anchor.selectedTextSnapshot}”</p>
            {target.kind === "edit" && target.note.blockEntryId !== null ? (
              <a
                className={buttonVariants({ size: "sm", variant: "ghost" })}
                href={`#/reader?work=${encodeURIComponent(
                  target.note.workEntryId ?? ""
                )}&block=${encodeURIComponent(target.note.blockEntryId)}`}
              >
                Open in Reader
              </a>
            ) : null}
          </div>
        ) : null}

        <RichContentEditor
          ariaLabel="Note body"
          document={initialBody}
          onChange={setDraft}
          onSave={() => void onSave()}
          presentation="compact"
        />

        {error !== undefined ? <p role="alert">{error}</p> : null}

        <div className="noteEditorActions">
          <Button disabled={blank} onClick={() => void onSave()} pending={saving} type="button">
            Save note
          </Button>
          <Button onClick={onClose} type="button" variant="secondary">
            Cancel
          </Button>
        </div>

        {target.kind === "edit" ? (
          <>
            <OwnedNoteReviewSection note={target.note} />

            <section aria-label="Delete note" className="noteEditorDanger">
              {confirmingDelete ? (
                <div>
                  <p>
                    Delete this note
                    {anchor !== null ? <> “{anchor.selectedTextSnapshot}”</> : null}? This cannot be
                    undone.
                  </p>
                  <div className="noteEditorActions">
                    <Button
                      onClick={onConfirmDelete}
                      pending={deleting}
                      type="button"
                      variant="primary"
                    >
                      Delete note
                    </Button>
                    <Button
                      disabled={deleting}
                      onClick={() => setConfirmingDelete(false)}
                      type="button"
                      variant="secondary"
                    >
                      Keep note
                    </Button>
                  </div>
                </div>
              ) : (
                <Button onClick={() => setConfirmingDelete(true)} type="button" variant="ghost">
                  Delete note
                </Button>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
