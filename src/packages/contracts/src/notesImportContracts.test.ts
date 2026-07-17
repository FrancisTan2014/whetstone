import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  importNotesRequestSchema,
  importNotesResultDtoSchema,
  parseImportNotesRequest,
  parseImportNotesResultDto
} from "./notesImportContracts.js";

const blankDoc = { type: "doc", content: [{ type: "paragraph" }] };

describe("notes import request contracts (#661)", () => {
  it("parses a batch of Question/Note rows", () => {
    const request = parseImportNotesRequest({
      items: [
        { questionDoc: createTextDocument("cap of France?"), noteDoc: createTextDocument("Paris") },
        { questionDoc: createTextDocument("cap of Japan?"), noteDoc: createTextDocument("Tokyo") }
      ]
    });

    expect(request.items).toHaveLength(2);
    expect(request.items[0]?.questionDoc).toEqual(createTextDocument("cap of France?"));
    expect(request.items[1]?.noteDoc).toEqual(createTextDocument("Tokyo"));
  });

  it("rejects an empty batch", () => {
    expect(() => parseImportNotesRequest({ items: [] })).toThrow();
  });

  it("rejects a blank Question document", () => {
    expect(() =>
      parseImportNotesRequest({
        items: [{ questionDoc: blankDoc, noteDoc: createTextDocument("Paris") }]
      })
    ).toThrow();
  });

  it("rejects a blank Note document", () => {
    expect(() =>
      parseImportNotesRequest({
        items: [{ questionDoc: createTextDocument("cap?"), noteDoc: blankDoc }]
      })
    ).toThrow();
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseImportNotesRequest({
        items: [{ questionDoc: { type: "nope" }, noteDoc: createTextDocument("Paris") }]
      })
    ).toThrow();
  });

  it("rejects unknown keys on an item", () => {
    expect(() =>
      importNotesRequestSchema.parse({
        items: [
          {
            questionDoc: createTextDocument("cap?"),
            noteDoc: createTextDocument("Paris"),
            answerDoc: createTextDocument("Paris")
          }
        ]
      })
    ).toThrow();
  });

  it("rejects unknown keys on the request", () => {
    expect(() =>
      importNotesRequestSchema.parse({
        items: [{ questionDoc: createTextDocument("cap?"), noteDoc: createTextDocument("Paris") }],
        count: 1
      })
    ).toThrow();
  });
});

describe("notes import result contracts (#661)", () => {
  it("parses a result of created notes in order", () => {
    const result = parseImportNotesResultDto({
      imported: [
        { noteEntryId: "note-1", promptId: "prompt-1" },
        { noteEntryId: "note-2", promptId: "prompt-2" }
      ]
    });

    expect(result.imported).toHaveLength(2);
    expect(result.imported[0]).toEqual({ noteEntryId: "note-1", promptId: "prompt-1" });
  });

  it("parses an empty result", () => {
    expect(parseImportNotesResultDto({ imported: [] })).toEqual({ imported: [] });
  });

  it("rejects a blank note id", () => {
    expect(() =>
      importNotesResultDtoSchema.parse({ imported: [{ noteEntryId: "", promptId: "prompt-1" }] })
    ).toThrow();
  });

  it("rejects a blank prompt id", () => {
    expect(() =>
      importNotesResultDtoSchema.parse({ imported: [{ noteEntryId: "note-1", promptId: "" }] })
    ).toThrow();
  });

  it("rejects unknown keys on the result", () => {
    expect(() =>
      importNotesResultDtoSchema.parse({
        imported: [{ noteEntryId: "note-1", promptId: "prompt-1" }],
        total: 1
      })
    ).toThrow();
  });
});
