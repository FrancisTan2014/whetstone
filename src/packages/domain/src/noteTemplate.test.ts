import { describe, expect, it } from "vitest";

import {
  getNoteTemplate,
  isNoteFieldType,
  noteFieldTypes,
  noteTemplates,
  preselectTemplateId
} from "./index.js";

describe("noteTemplates", () => {
  it("exposes the three v0 templates with stable ids and names", () => {
    expect(noteTemplates.map((template) => template.id)).toEqual([
      "vocabulary",
      "expression",
      "thought"
    ]);
    expect(noteTemplates.map((template) => template.name)).toEqual([
      "Vocabulary",
      "Expression / phrase",
      "Thought / question"
    ]);
  });

  it("only uses v0 field types and deeply freezes the template data", () => {
    expect(Object.isFrozen(noteTemplates)).toBe(true);

    for (const template of noteTemplates) {
      expect(Object.isFrozen(template)).toBe(true);
      expect(Object.isFrozen(template.fields)).toBe(true);

      for (const field of template.fields) {
        expect(noteFieldTypes).toContain(field.type);
        expect(Object.isFrozen(field)).toBe(true);
      }
    }
  });

  it("includes the documented vocabulary fields with both field types", () => {
    const vocabulary = getNoteTemplate("vocabulary");

    expect(vocabulary?.fields.map((field) => field.label)).toEqual([
      "Meaning in this context",
      "My explanation or translation",
      "Memory hook",
      "Example I might use"
    ]);
    expect(vocabulary?.fields.find((field) => field.id === "memory_hook")?.type).toBe("short_text");
    expect(vocabulary?.fields.find((field) => field.id === "meaning")?.type).toBe("long_text");
  });
});

describe("getNoteTemplate", () => {
  it("returns undefined for an unknown id", () => {
    expect(getNoteTemplate("missing")).toBeUndefined();
  });
});

describe("isNoteFieldType", () => {
  it("accepts known field types and rejects anything else", () => {
    expect(isNoteFieldType("short_text")).toBe(true);
    expect(isNoteFieldType("long_text")).toBe(true);
    expect(isNoteFieldType("rich_text")).toBe(false);
    expect(isNoteFieldType(42)).toBe(false);
  });
});

describe("preselectTemplateId", () => {
  it("preselects Vocabulary for a single word", () => {
    expect(preselectTemplateId("ineffable")).toBe("vocabulary");
    expect(preselectTemplateId("  spaced  ")).toBe("vocabulary");
  });

  it("preselects Expression / phrase for a short phrase of two to six words", () => {
    expect(preselectTemplateId("a turn of phrase")).toBe("expression");
    expect(preselectTemplateId("one two three four five six")).toBe("expression");
  });

  it("preselects Thought / question for a longer selection of more than six words", () => {
    expect(preselectTemplateId("one two three four five six seven")).toBe("thought");
  });
});
