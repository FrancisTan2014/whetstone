import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteDto, NoteTemplateDto } from "@whetstone/contracts";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so a rendered
// note body never executes raw markup.
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

type NoteListProps = Readonly<{
  emptyLabel: string;
  notes: ReadonlyArray<NoteDto>;
  onDelete: (note: NoteDto) => void;
  onEdit: (note: NoteDto) => void;
  templates: ReadonlyArray<NoteTemplateDto>;
}>;

function templateName(templates: ReadonlyArray<NoteTemplateDto>, templateId: string): string {
  return templates.find((template) => template.id === templateId)?.name ?? templateId;
}

// Presentational list of notes with their anchored snippet, rendered body, and edit/delete
// controls. Reused for the per-work note list and the per-block reopen panel; it holds no
// state so its parent owns selection, editing, and deletion.
export function NoteList({
  emptyLabel,
  notes,
  onDelete,
  onEdit,
  templates
}: NoteListProps): React.JSX.Element {
  if (notes.length === 0) {
    return <p className="noteListEmpty">{emptyLabel}</p>;
  }

  return (
    <ul className="noteList">
      {notes.map((note) => (
        <li className="noteListItem" key={note.entryId}>
          <p className="noteListSnippet">“{note.anchor.selectedTextSnapshot}”</p>
          <p className="noteListTemplate">{templateName(templates, note.templateId)}</p>
          <div className="noteListBody">
            <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
              {note.markdown}
            </Markdown>
          </div>
          <div className="noteListActions">
            <button
              aria-label={`Edit note: ${note.anchor.selectedTextSnapshot}`}
              onClick={() => onEdit(note)}
              type="button"
            >
              Edit
            </button>
            <button
              aria-label={`Delete note: ${note.anchor.selectedTextSnapshot}`}
              onClick={() => onDelete(note)}
              type="button"
            >
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
