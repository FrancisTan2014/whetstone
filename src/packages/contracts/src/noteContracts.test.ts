import { describe, expect, it } from "vitest";

import {
  createMarkRequestSchema,
  createNoteRequestSchema,
  parseCreateMarkRequest,
  parseCreateNoteRequest,
  parseNoteTemplateDto,
  parseUpdateNoteRequest,
  updateNoteRequestSchema
} from "./noteContracts.js";

const validTemplate = {
  fields: [
    { id: "meaning", label: "Meaning in this context", type: "long_text" },
    { id: "memory_hook", label: "Memory hook", type: "short_text" }
  ],
  id: "vocabulary",
  name: "Vocabulary"
} as const;

const validRequest = {
  answers: { meaning: "to surrender" },
  anchor: {
    blockEntryId: "block-1",
    contextSnapshot: "He would not capitulate.",
    endOffset: 18,
    selectedTextSnapshot: "capitulate",
    startOffset: 8
  },
  templateId: "vocabulary"
} as const;

describe("createNoteRequestSchema", () => {
  it("parses a well-formed create-note request", () => {
    const parsed = parseCreateNoteRequest(validRequest);

    expect(parsed.templateId).toBe("vocabulary");
    expect(parsed.answers).toEqual({ meaning: "to surrender" });
    expect(parsed.anchor).toEqual(validRequest.anchor);
  });

  it("accepts a whole-block anchor without an offset range", () => {
    const parsed = parseCreateNoteRequest({
      ...validRequest,
      anchor: {
        blockEntryId: "block-1",
        contextSnapshot: "capitulate",
        selectedTextSnapshot: "capitulate"
      }
    });

    expect(parsed.anchor.startOffset).toBeUndefined();
  });

  it("rejects a blank template id and unexpected keys", () => {
    expect(() => parseCreateNoteRequest({ ...validRequest, templateId: " " })).toThrow();
    expect(() => parseCreateNoteRequest({ ...validRequest, extra: true })).toThrow();
    expect(createNoteRequestSchema.safeParse({ answers: {}, templateId: "x" }).success).toBe(false);
  });
});

describe("createMarkRequestSchema", () => {
  it("parses a mark request carrying only the anchor", () => {
    const parsed = parseCreateMarkRequest({ anchor: validRequest.anchor });

    expect(parsed.anchor).toEqual(validRequest.anchor);
  });

  it("rejects a mark request with a template, answers, or unexpected keys", () => {
    expect(
      createMarkRequestSchema.safeParse({ anchor: validRequest.anchor, templateId: "vocabulary" })
        .success
    ).toBe(false);
    expect(() => parseCreateMarkRequest({ anchor: validRequest.anchor, answers: {} })).toThrow();
    expect(() => parseCreateMarkRequest({})).toThrow();
  });
});

describe("updateNoteRequestSchema", () => {
  it("parses a well-formed update-note request", () => {
    const parsed = parseUpdateNoteRequest({
      answers: { meaning: "to give in" },
      templateId: "vocabulary"
    });

    expect(parsed).toEqual({ answers: { meaning: "to give in" }, templateId: "vocabulary" });
  });

  it("rejects a blank template id and unexpected keys", () => {
    expect(() => parseUpdateNoteRequest({ answers: { meaning: "x" }, templateId: " " })).toThrow();
    expect(
      updateNoteRequestSchema.safeParse({
        answers: { meaning: "x" },
        anchor: {},
        templateId: "vocabulary"
      }).success
    ).toBe(false);
  });
});

describe("parseNoteTemplateDto", () => {
  it("parses a seeded template row", () => {
    expect(parseNoteTemplateDto(validTemplate)).toEqual(validTemplate);
  });

  it("rejects templates with no fields or an unknown field type", () => {
    expect(() => parseNoteTemplateDto({ ...validTemplate, fields: [] })).toThrow();
    expect(() =>
      parseNoteTemplateDto({
        ...validTemplate,
        fields: [{ id: "x", label: "X", type: "rich_text" }]
      })
    ).toThrow();
  });
});
