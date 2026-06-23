// v0 note templates are a small controlled shape (ordered fields with a label and a
// field type), not arbitrary UI. They are seeded into the database from this canonical
// definition; the note editor loads them from the API and never hard-codes them.
export const noteFieldTypes = ["short_text", "long_text"] as const;

export type NoteFieldType = (typeof noteFieldTypes)[number];

export type NoteTemplateField = Readonly<{
  id: string;
  label: string;
  type: NoteFieldType;
}>;

export type NoteTemplate = Readonly<{
  fields: ReadonlyArray<NoteTemplateField>;
  id: string;
  name: string;
}>;

// Stable template ids double as the seed primary keys and the preselection result, so
// they are named once here and reused.
const vocabularyTemplateId = "vocabulary";
const expressionTemplateId = "expression";
const thoughtTemplateId = "thought";

const noteFieldTypeSet: ReadonlySet<unknown> = new Set(noteFieldTypes);

function freezeTemplate(template: NoteTemplate): NoteTemplate {
  return Object.freeze({
    fields: Object.freeze(template.fields.map((field) => Object.freeze({ ...field }))),
    id: template.id,
    name: template.name
  });
}

const templateDefinitions: ReadonlyArray<NoteTemplate> = [
  {
    fields: [
      { id: "meaning", label: "Meaning in this context", type: "long_text" },
      { id: "explanation", label: "My explanation or translation", type: "long_text" },
      { id: "memory_hook", label: "Memory hook", type: "short_text" },
      { id: "example", label: "Example I might use", type: "long_text" }
    ],
    id: vocabularyTemplateId,
    name: "Vocabulary"
  },
  {
    fields: [
      { id: "doing", label: "What the phrase is doing", type: "long_text" },
      { id: "useful", label: "Why it sounds useful", type: "long_text" },
      { id: "imitation", label: "My imitation sentence", type: "long_text" }
    ],
    id: expressionTemplateId,
    name: "Expression / phrase"
  },
  {
    fields: [
      { id: "noticed", label: "What I noticed", type: "long_text" },
      { id: "matters", label: "Why it matters", type: "long_text" },
      { id: "question", label: "Question or connection", type: "long_text" }
    ],
    id: thoughtTemplateId,
    name: "Thought / question"
  }
];

export const noteTemplates: ReadonlyArray<NoteTemplate> = Object.freeze(
  templateDefinitions.map(freezeTemplate)
);

export function isNoteFieldType(value: unknown): value is NoteFieldType {
  return noteFieldTypeSet.has(value);
}

export function getNoteTemplate(id: string): NoteTemplate | undefined {
  return noteTemplates.find((template) => template.id === id);
}

// Preselect a likely template from the selection size, using the concrete thresholds
// from PRODUCT.md: a single word -> Vocabulary, a short phrase (2-6 words) ->
// Expression / phrase, a longer selection -> Thought / question. The user can switch
// before saving. Word counting is whitespace based; scripts without word spacing fall
// through to the single-word case, which is a sensible v0 default.
export function preselectTemplateId(selectedText: string): string {
  const wordCount = selectedText
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  if (wordCount <= 1) {
    return vocabularyTemplateId;
  }

  if (wordCount <= 6) {
    return expressionTemplateId;
  }

  return thoughtTemplateId;
}
