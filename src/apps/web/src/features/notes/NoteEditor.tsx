import { useState } from "react";

import type { AnchoredNoteDto, CreateNoteRequest } from "@whetstone/contracts";
import { documentText, type DocumentNodeJSON } from "@whetstone/document";

import { RichContentEditor } from "../../shared/editor/index.js";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";
import { createNote, updateNote } from "./notesApi";
import { draftToAnchor, type NoteDraft } from "./noteCapture";
import { NoteReviewSection } from "./NoteReviewSection";

// The editor opens either to capture a new note from a reader selection, or to edit an existing note
// reopened from a highlight or the note list. A note is always authored content — one rich body, no
// template choice and no classification; a bodyless Mark (#255) is never routed here.
export type NoteEditorTarget =
  | Readonly<{ draft: NoteDraft; kind: "create" }>
  | Readonly<{ kind: "edit"; note: AnchoredNoteDto }>;

type NoteEditorProps = Readonly<{
  onClose: () => void;
  onSaved: (note: AnchoredNoteDto) => void;
  target: NoteEditorTarget;
  workEntryId: string;
}>;

function selectionTextFor(target: NoteEditorTarget): string {
  return target.kind === "create"
    ? target.draft.selectedText
    : target.note.anchor.selectedTextSnapshot;
}

function initialBodyFor(target: NoteEditorTarget): DocumentNodeJSON {
  // A new capture starts from an empty document; an edited note always carries a canonical body
  // (`kind = 'note'` ⇒ non-null `body_doc`), so the cast is sound — a Mark never reaches the editor.
  return target.kind === "create"
    ? createEmptyDocument()
    : (target.note.bodyDoc as DocumentNodeJSON);
}

// The editor is hosted in the shared responsive `Sheet` (right-docked side panel on desktop, bottom
// sheet above the keyboard on mobile) and opens straight to ONE focused rich body. The selected source
// text shows as read-only anchor context outside the editable body — it is provenance, never copied
// into the note. Save is disabled while the body is blank and a blank save attempt is announced
// through an accessible alert; the server always re-derives the readable projection.
export function NoteEditor({
  onClose,
  onSaved,
  target,
  workEntryId
}: NoteEditorProps): React.JSX.Element {
  // The editor's initial document must stay stable for the lifetime of this target: the shared
  // `RichContentEditor` treats `document` as authoritative and resets its content whenever the prop
  // changes identity. In create mode `initialBodyFor` mints a fresh empty document on every render, so
  // recomputing it inline would wipe the user's text on each keystroke. Compute it once (lazily) and
  // keep sending the live `draft` to save. The parent remounts `NoteEditor` per target (keyed), so a
  // new target gets a fresh initial document.
  const [initialBody] = useState<DocumentNodeJSON>(() => initialBodyFor(target));
  const [draft, setDraft] = useState<DocumentNodeJSON>(initialBody);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const heading = target.kind === "create" ? "New note" : "Edit note";
  const blank = documentText(draft).trim().length === 0;

  async function persist(): Promise<AnchoredNoteDto> {
    if (target.kind === "create") {
      const request: CreateNoteRequest = { anchor: draftToAnchor(target.draft), bodyDoc: draft };
      return createNote(workEntryId, request);
    }

    return updateNote(workEntryId, target.note.entryId, { bodyDoc: draft });
  }

  async function onSave(): Promise<void> {
    if (blank) {
      setError("Write something before saving the note.");
      return;
    }

    let saved: AnchoredNoteDto;

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

  return (
    <Sheet onOpenChange={onClose} open size="wide" title={heading}>
      <div className="noteEditor">
        <p className="noteEditorSelection">Selected: {selectionTextFor(target)}</p>

        <RichContentEditor
          ariaLabel="Note body"
          document={initialBody}
          onChange={setDraft}
          onSave={() => void onSave()}
          presentation="workspace"
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
          <NoteReviewSection
            noteEntryId={target.note.entryId}
            question={target.note.anchor.selectedTextSnapshot}
            workEntryId={workEntryId}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
