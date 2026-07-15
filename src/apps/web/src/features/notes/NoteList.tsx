import type { AnchoredNoteDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { noteChipSwatchClass } from "./noteChip.tokens";

type NoteListProps = Readonly<{
  emptyLabel: string;
  notes: ReadonlyArray<AnchoredNoteDto>;
  onDelete: (note: AnchoredNoteDto) => void;
  onEdit: (note: AnchoredNoteDto) => void;
  onJump: (note: AnchoredNoteDto) => void;
}>;

// Presentational list of note cards: each shows the note/mark chip, the anchored selected-text
// snapshot, a preview of the note's rich body (the server-derived readable projection — a Mark shows
// no body), and jump/edit/delete controls. Reused for the per-work note list and the per-block reopen
// panel; it holds no state so its parent owns jumping, editing, and deletion.
export function NoteList({
  emptyLabel,
  notes,
  onDelete,
  onEdit,
  onJump
}: NoteListProps): React.JSX.Element {
  if (notes.length === 0) {
    return <p className="noteListEmpty">{emptyLabel}</p>;
  }

  return (
    <ul className="noteList">
      {notes.map((note) => {
        const isMark = note.kind === "mark";

        return (
          <li className="noteCard" key={note.entryId}>
            <div className="noteCardHeader">
              <span className={`noteCardChip ${noteChipSwatchClass(note.kind)}`}>
                {isMark ? "Gem" : "Note"}
              </span>
            </div>
            <p className="noteCardSnippet">“{note.anchor.selectedTextSnapshot}”</p>
            {isMark ? null : <p className="noteCardBody">{note.bodyText}</p>}
            <div className="noteCardActions">
              <Button
                aria-label={`Jump to text: ${note.anchor.selectedTextSnapshot}`}
                onClick={() => onJump(note)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Jump to text
              </Button>
              {isMark ? null : (
                <Button
                  aria-label={`Edit note: ${note.anchor.selectedTextSnapshot}`}
                  onClick={() => onEdit(note)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Edit
                </Button>
              )}
              <Button
                aria-label={`Delete ${isMark ? "mark" : "note"}: ${note.anchor.selectedTextSnapshot}`}
                onClick={() => onDelete(note)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Delete
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
