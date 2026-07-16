// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { noteMarkLabel, resolveActivatedNotes } from "./noteActivation";

function note(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("b1"),
      contextSnapshot: "First block text.",
      endBlockEntryId: toEntryId("b1"),
      endOffset: 11,
      selectedTextSnapshot: "block",
      startOffset: 6
    },
    blockEntryId: toEntryId("b1"),
    bodyDoc: createTextDocument("a note"),
    bodyText: "a note",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function mark(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return note({
    bodyDoc: null,
    bodyText: null,
    entryId: toEntryId("mark-1"),
    kind: "mark",
    ...overrides
  });
}

describe("noteMarkLabel", () => {
  it("names a rich note by kind and anchored text", () => {
    expect(noteMarkLabel("note", "block")).toBe("Open note on 'block'");
  });

  it("names a bodyless mark as a mark", () => {
    expect(noteMarkLabel("mark", "block")).toBe("Open mark on 'block'");
  });
});

describe("resolveActivatedNotes", () => {
  it("opens a lone rich note's editor directly", () => {
    const only = note();

    expect(resolveActivatedNotes(["note-1"], [only])).toEqual({ kind: "note", note: only });
  });

  it("opens the compact chooser for a lone bodyless mark (its own actions)", () => {
    const only = mark();

    expect(resolveActivatedNotes(["mark-1"], [only])).toEqual({ kind: "chooser", notes: [only] });
  });

  it("opens the chooser scoped to the genuinely overlapping annotations", () => {
    const outer = note({ entryId: toEntryId("note-1") });
    const inner = mark({ entryId: toEntryId("mark-1") });

    expect(resolveActivatedNotes(["mark-1", "note-1"], [outer, inner])).toEqual({
      kind: "chooser",
      notes: [inner, outer]
    });
  });

  it("resolves to nothing when no loaded note matches the activated id", () => {
    expect(resolveActivatedNotes(["gone"], [note()])).toBeUndefined();
  });

  it("ignores unknown ids and opens the single matching note directly", () => {
    const only = note();

    expect(resolveActivatedNotes(["gone", "note-1"], [only])).toEqual({ kind: "note", note: only });
  });
});
