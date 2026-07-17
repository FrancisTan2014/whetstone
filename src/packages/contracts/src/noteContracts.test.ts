import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  createMarkRequestSchema,
  createNoteRequestSchema,
  createStandaloneNoteRequestSchema,
  parseCreateMarkRequest,
  parseCreateNoteRequest,
  parseCreateStandaloneNoteRequest,
  parseUpdateNoteRequest,
  updateNoteRequestSchema
} from "./noteContracts.js";

const anchor = {
  blockEntryId: "block-1",
  contextSnapshot: "He would not capitulate.",
  endOffset: 18,
  selectedTextSnapshot: "capitulate",
  startOffset: 8
} as const;

const bodyDoc = createTextDocument("to surrender");

describe("createNoteRequestSchema", () => {
  it("parses a well-formed create-note request and defaults the end block", () => {
    const parsed = parseCreateNoteRequest({ anchor, bodyDoc });

    expect(parsed.bodyDoc).toEqual(bodyDoc);
    expect(parsed.anchor).toEqual({ ...anchor, endBlockEntryId: anchor.blockEntryId });
  });

  it("accepts a whole-block anchor without an offset range", () => {
    const parsed = parseCreateNoteRequest({
      anchor: {
        blockEntryId: "block-1",
        contextSnapshot: "capitulate",
        selectedTextSnapshot: "capitulate"
      },
      bodyDoc
    });

    expect(parsed.anchor.startOffset).toBeUndefined();
  });

  it("rejects a blank body, an invalid document, and unexpected keys", () => {
    // A blank document is not a note (whitespace-only trims to empty).
    expect(() => parseCreateNoteRequest({ anchor, bodyDoc: createTextDocument("   ") })).toThrow();
    // A malformed document fails the shared document validation.
    expect(() => parseCreateNoteRequest({ anchor, bodyDoc: { type: "not-a-doc" } })).toThrow();
    expect(createNoteRequestSchema.safeParse({ anchor, bodyDoc, extra: true }).success).toBe(false);
  });
});

describe("createMarkRequestSchema", () => {
  it("parses a mark request carrying only the anchor", () => {
    const parsed = parseCreateMarkRequest({ anchor });

    expect(parsed.anchor).toEqual({ ...anchor, endBlockEntryId: anchor.blockEntryId });
  });

  it("rejects a mark request that carries a body or unexpected keys", () => {
    expect(createMarkRequestSchema.safeParse({ anchor, bodyDoc }).success).toBe(false);
    expect(() => parseCreateMarkRequest({})).toThrow();
  });
});

describe("updateNoteRequestSchema", () => {
  it("parses a well-formed update-note request", () => {
    const parsed = parseUpdateNoteRequest({ bodyDoc });

    expect(parsed).toEqual({ bodyDoc });
  });

  it("rejects a blank body and unexpected keys (the anchor is fixed at capture)", () => {
    expect(() => parseUpdateNoteRequest({ bodyDoc: createTextDocument("") })).toThrow();
    expect(updateNoteRequestSchema.safeParse({ bodyDoc, anchor }).success).toBe(false);
  });
});

describe("createStandaloneNoteRequestSchema", () => {
  it("parses a standalone note carrying only a non-blank body (no anchor)", () => {
    const parsed = parseCreateStandaloneNoteRequest({ bodyDoc });

    expect(parsed).toEqual({ bodyDoc });
  });

  it("rejects a blank body, a missing body, or an anchor (standalone notes have no source)", () => {
    expect(() =>
      parseCreateStandaloneNoteRequest({ bodyDoc: createTextDocument("") })
    ).toThrow();
    expect(() => parseCreateStandaloneNoteRequest({})).toThrow();
    expect(createStandaloneNoteRequestSchema.safeParse({ bodyDoc, anchor }).success).toBe(false);
  });
});
