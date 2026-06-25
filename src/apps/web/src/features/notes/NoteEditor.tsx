import { useState } from "react";

import type { CreateNoteRequest, NoteDto, NoteTemplateDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";
import { createNote, updateNote } from "./notesApi";
import type { NoteDraft } from "./noteCapture";
import { templateSwatchClass } from "./templateHue";

// The editor opens either to capture a new note from a reader selection, or to edit an
// existing note reopened from a highlight or the note list.
export type NoteEditorTarget =
  | Readonly<{ draft: NoteDraft; kind: "create" }>
  | Readonly<{ kind: "edit"; note: NoteDto }>;

type NoteEditorProps = Readonly<{
  onClose: () => void;
  onSaved: (note: NoteDto) => void;
  target: NoteEditorTarget;
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

function buildCreateRequest(
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

function preselectionFor(target: NoteEditorTarget): string {
  return target.kind === "create" ? target.draft.preselectedTemplateId : target.note.templateId;
}

function selectionTextFor(target: NoteEditorTarget): string {
  return target.kind === "create"
    ? target.draft.selectedText
    : target.note.anchor.selectedTextSnapshot;
}

function initialAnswersFor(target: NoteEditorTarget): Record<string, string> {
  return target.kind === "create" ? {} : { ...target.note.answers };
}

// The editor is hosted in the shared responsive `Sheet` (right-docked side panel on
// desktop, bottom sheet above the keyboard on mobile). The active template is derived
// from the current `templates` prop each render (falling back to the size-based
// preselection for a new note, or the note's own template when editing) so templates that
// load after the editor opens are used; an explicit choice, once made, takes precedence.
export function NoteEditor({
  onClose,
  onSaved,
  target,
  templates,
  workEntryId
}: NoteEditorProps): React.JSX.Element {
  const [chosenTemplateId, setChosenTemplateId] = useState<string | undefined>(undefined);
  const [answers, setAnswers] = useState<Record<string, string>>(() => initialAnswersFor(target));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const activeTemplateId =
    chosenTemplateId ?? initialTemplateId(templates, preselectionFor(target));
  const template = templates.find((candidate) => candidate.id === activeTemplateId);
  const heading = target.kind === "create" ? "New note" : "Edit note";

  if (template === undefined) {
    return (
      <Sheet onOpenChange={onClose} open title={heading}>
        <p role="alert">Note templates are unavailable. Please try again.</p>
      </Sheet>
    );
  }

  function setAnswer(fieldId: string, value: string): void {
    setAnswers((previous) => ({ ...previous, [fieldId]: value }));
  }

  async function persist(currentTemplate: NoteTemplateDto): Promise<NoteDto> {
    const filled: Record<string, string> = {};

    for (const field of currentTemplate.fields) {
      filled[field.id] = answers[field.id] ?? "";
    }

    if (!Object.values(filled).some((value) => value.trim().length > 0)) {
      throw new Error("empty");
    }

    if (target.kind === "create") {
      return createNote(workEntryId, buildCreateRequest(target.draft, currentTemplate.id, filled));
    }

    return updateNote(workEntryId, target.note.entryId, {
      answers: filled,
      templateId: currentTemplate.id
    });
  }

  async function onSave(currentTemplate: NoteTemplateDto): Promise<void> {
    let saved: NoteDto;

    setError(undefined);
    setSaving(true);

    try {
      saved = await persist(currentTemplate);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === "empty"
          ? "Add at least one answer before saving."
          : "Could not save the note. Please try again."
      );
      return;
    } finally {
      setSaving(false);
    }

    onSaved(saved);
  }

  return (
    <Sheet onOpenChange={onClose} open title={heading}>
      <div className="noteEditor">
        <p className="noteEditorSelection">Selected: {selectionTextFor(target)}</p>

        <div aria-label="Template" className="noteEditorTemplates" role="group">
          {templates.map((candidate) => (
            <button
              aria-label={candidate.name}
              aria-pressed={candidate.id === template.id}
              className={`noteEditorTemplate ${templateSwatchClass(candidate.id)}`}
              key={candidate.id}
              onClick={() => setChosenTemplateId(candidate.id)}
              type="button"
            >
              {candidate.name}
            </button>
          ))}
        </div>

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
          <Button onClick={() => void onSave(template)} pending={saving} type="button">
            Save note
          </Button>
          <Button onClick={onClose} type="button" variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
