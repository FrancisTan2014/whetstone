import { useState } from "react";

import type { CreateNoteRequest, NoteDto, NoteTemplateDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { createNote } from "./notesApi";
import type { NoteDraft } from "./noteCapture";

type NoteEditorProps = Readonly<{
  draft: NoteDraft;
  onClose: () => void;
  onSaved: (note: NoteDto) => void;
  templates: ReadonlyArray<NoteTemplateDto>;
  workEntryId: string;
}>;

function initialTemplateId(
  templates: ReadonlyArray<NoteTemplateDto>,
  preselectedId: string
): string | undefined {
  const preselected = templates.find((template) => template.id === preselectedId);

  return preselected?.id ?? templates[0]?.id;
}

function buildRequest(
  draft: NoteDraft,
  templateId: string,
  answers: Record<string, string>
): CreateNoteRequest {
  const blockEntryId = toEntryId(draft.blockEntryId);

  if (draft.startOffset === undefined || draft.endOffset === undefined) {
    return {
      answers,
      anchor: {
        blockEntryId,
        contextSnapshot: draft.contextSnapshot,
        selectedTextSnapshot: draft.selectedText
      },
      templateId
    };
  }

  return {
    answers,
    anchor: {
      blockEntryId,
      contextSnapshot: draft.contextSnapshot,
      endOffset: draft.endOffset,
      selectedTextSnapshot: draft.selectedText,
      startOffset: draft.startOffset
    },
    templateId
  };
}

// The editor opens after a reader selection. On desktop widths it is a side panel and on
// narrow widths a bottom sheet (see styles.css); the markup is the same either way.
export function NoteEditor({
  draft,
  onClose,
  onSaved,
  templates,
  workEntryId
}: NoteEditorProps): React.JSX.Element {
  const [templateId, setTemplateId] = useState<string | undefined>(() =>
    initialTemplateId(templates, draft.preselectedTemplateId)
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const template = templates.find((candidate) => candidate.id === templateId);

  if (template === undefined) {
    return (
      <aside aria-label="Note editor" className="noteEditor">
        <p role="alert">Note templates are unavailable. Please try again.</p>
        <button onClick={onClose} type="button">
          Close
        </button>
      </aside>
    );
  }

  function setAnswer(fieldId: string, value: string): void {
    setAnswers((previous) => ({ ...previous, [fieldId]: value }));
  }

  async function onSave(currentTemplate: NoteTemplateDto): Promise<void> {
    const filled: Record<string, string> = {};

    for (const field of currentTemplate.fields) {
      filled[field.id] = answers[field.id] ?? "";
    }

    if (!Object.values(filled).some((value) => value.trim().length > 0)) {
      setError("Add at least one answer before saving.");
      return;
    }

    try {
      const note = await createNote(workEntryId, buildRequest(draft, currentTemplate.id, filled));
      onSaved(note);
    } catch {
      setError("Could not save the note. Please try again.");
    }
  }

  return (
    <aside aria-label="Note editor" className="noteEditor">
      <h2>New note</h2>
      <p className="noteEditorSelection">Selected: {draft.selectedText}</p>

      <label htmlFor="note-template">Template</label>
      <select
        id="note-template"
        onChange={(event) => setTemplateId(event.currentTarget.value)}
        value={template.id}
      >
        {templates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name}
          </option>
        ))}
      </select>

      {template.fields.map((field) => (
        <div className="noteEditorField" key={field.id}>
          <label htmlFor={`note-field-${field.id}`}>{field.label}</label>
          {field.type === "long_text" ? (
            <textarea
              id={`note-field-${field.id}`}
              onChange={(event) => setAnswer(field.id, event.currentTarget.value)}
              value={answers[field.id] ?? ""}
            />
          ) : (
            <input
              id={`note-field-${field.id}`}
              onChange={(event) => setAnswer(field.id, event.currentTarget.value)}
              type="text"
              value={answers[field.id] ?? ""}
            />
          )}
        </div>
      ))}

      {error !== undefined ? <p role="alert">{error}</p> : null}

      <div className="noteEditorActions">
        <button onClick={() => void onSave(template)} type="button">
          Save note
        </button>
        <button onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </aside>
  );
}
