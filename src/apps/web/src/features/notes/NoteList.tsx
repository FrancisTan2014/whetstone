import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteDto, NoteTemplateDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { templateSwatchClass } from "./templateHue";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so a rendered
// note body never executes raw markup.
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

type NoteListProps = Readonly<{
  emptyLabel: string;
  notes: ReadonlyArray<NoteDto>;
  onDelete: (note: NoteDto) => void;
  onEdit: (note: NoteDto) => void;
  onJump: (note: NoteDto) => void;
  templates: ReadonlyArray<NoteTemplateDto>;
}>;

function templateName(templates: ReadonlyArray<NoteTemplateDto>, templateId: string): string {
  return templates.find((template) => template.id === templateId)?.name ?? templateId;
}

// Presentational list of note cards: each shows a hued template chip, the anchored
// selected-text snapshot, the rendered answers, and jump/edit/delete controls. Reused for
// the per-work note list and the per-block reopen panel; it holds no state so its parent
// owns jumping, editing, and deletion.
export function NoteList({
  emptyLabel,
  notes,
  onDelete,
  onEdit,
  onJump,
  templates
}: NoteListProps): React.JSX.Element {
  if (notes.length === 0) {
    return <p className="noteListEmpty">{emptyLabel}</p>;
  }

  return (
    <ul className="noteList">
      {notes.map((note) => (
        <li className="noteCard" key={note.entryId}>
          <div className="noteCardHeader">
            <span className={`noteCardChip ${templateSwatchClass(note.templateId)}`}>
              {templateName(templates, note.templateId)}
            </span>
          </div>
          <p className="noteCardSnippet">“{note.anchor.selectedTextSnapshot}”</p>
          <div className="noteCardBody">
            <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
              {note.markdown}
            </Markdown>
          </div>
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
            <Button
              aria-label={`Edit note: ${note.anchor.selectedTextSnapshot}`}
              onClick={() => onEdit(note)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Edit
            </Button>
            <Button
              aria-label={`Delete note: ${note.anchor.selectedTextSnapshot}`}
              onClick={() => onDelete(note)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Delete
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
