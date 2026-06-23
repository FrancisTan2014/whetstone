import { describe, expect, it } from "vitest";

import { getNoteTemplate, renderNoteMarkdown, validateNoteAnswers } from "./index.js";
import type { NoteTemplate } from "./index.js";

const vocabulary = getNoteTemplate("vocabulary") as NoteTemplate;

describe("validateNoteAnswers", () => {
  it("accepts answers limited to the template fields and freezes them", () => {
    const result = validateNoteAnswers(vocabulary, { meaning: "to surrender", memory_hook: "" });

    expect(result.status).toBe("valid");

    if (result.status === "valid") {
      expect(result.answers).toEqual({ meaning: "to surrender", memory_hook: "" });
      expect(Object.isFrozen(result.answers)).toBe(true);
    }
  });

  it("rejects answers that reference an unknown field", () => {
    expect(validateNoteAnswers(vocabulary, { mystery: "x" })).toEqual({
      fieldId: "mystery",
      status: "unknown_field"
    });
  });

  it("rejects a note whose answers are all blank", () => {
    expect(validateNoteAnswers(vocabulary, { meaning: "   " })).toEqual({ status: "empty" });
  });
});

describe("renderNoteMarkdown", () => {
  it("renders answered fields as labelled Markdown in template order", () => {
    const markdown = renderNoteMarkdown(vocabulary, {
      example: "I won't capitulate.",
      meaning: "to surrender"
    });

    expect(markdown).toBe(
      "**Meaning in this context**\n\nto surrender\n\n**Example I might use**\n\nI won't capitulate."
    );
  });

  it("omits blank fields, yielding empty Markdown when nothing is answered", () => {
    expect(renderNoteMarkdown(vocabulary, { meaning: "", memory_hook: "  " })).toBe("");
  });
});
