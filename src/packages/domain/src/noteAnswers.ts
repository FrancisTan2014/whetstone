import type { NoteTemplate } from "./noteTemplate.js";

// Answers are stored structurally, keyed by template field id. A note must answer at
// least one field, and may only use the fields its template defines.
export type NoteAnswers = Readonly<Record<string, string>>;

export type NoteAnswerValidation =
  | Readonly<{ answers: NoteAnswers; status: "valid" }>
  | Readonly<{ fieldId: string; status: "unknown_field" }>
  | Readonly<{ status: "empty" }>;

export function validateNoteAnswers(
  template: NoteTemplate,
  answers: Record<string, string>
): NoteAnswerValidation {
  const fieldIds = new Set(template.fields.map((field) => field.id));

  for (const key of Object.keys(answers)) {
    if (!fieldIds.has(key)) {
      return { fieldId: key, status: "unknown_field" };
    }
  }

  const hasAnswer = template.fields.some((field) => (answers[field.id] ?? "").trim().length > 0);

  if (!hasAnswer) {
    return { status: "empty" };
  }

  return { answers: Object.freeze({ ...answers }), status: "valid" };
}

// Derive the Markdown note body from the template and answers. Blank fields are
// omitted; each answered field becomes a bold label followed by its value. This is a
// derived projection, not the only store — the structured answers remain authoritative.
export function renderNoteMarkdown(
  template: NoteTemplate,
  answers: Record<string, string>
): string {
  return template.fields
    .map((field) => ({ label: field.label, value: (answers[field.id] ?? "").trim() }))
    .filter((entry) => entry.value.length > 0)
    .map((entry) => `**${entry.label}**\n\n${entry.value}`)
    .join("\n\n");
}
