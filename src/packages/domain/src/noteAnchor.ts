import type { EntryId } from "./entry.js";

export type NoteAnchor = Readonly<{
  contextSnapshot: string;
  endOffset: number;
  readingUnitEntryId: EntryId;
  selectedTextSnapshot: string;
  startOffset: number;
}>;

export type CreateNoteAnchorInput = NoteAnchor;

export function createNoteAnchor(input: CreateNoteAnchorInput): NoteAnchor {
  assertNonNegativeInteger("startOffset", input.startOffset);
  assertNonNegativeInteger("endOffset", input.endOffset);

  if (input.endOffset <= input.startOffset) {
    throw new Error("NoteAnchor endOffset must be greater than startOffset.");
  }

  assertNonEmptySnapshot("selectedTextSnapshot", input.selectedTextSnapshot);
  assertNonEmptySnapshot("contextSnapshot", input.contextSnapshot);

  if (!input.contextSnapshot.includes(input.selectedTextSnapshot)) {
    throw new Error("NoteAnchor contextSnapshot must contain selectedTextSnapshot.");
  }

  return Object.freeze({
    contextSnapshot: input.contextSnapshot,
    endOffset: input.endOffset,
    readingUnitEntryId: input.readingUnitEntryId,
    selectedTextSnapshot: input.selectedTextSnapshot,
    startOffset: input.startOffset
  });
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`NoteAnchor ${name} must be an integer.`);
  }

  if (value < 0) {
    throw new Error(`NoteAnchor ${name} must be non-negative.`);
  }
}

function assertNonEmptySnapshot(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`NoteAnchor ${name} must be non-empty.`);
  }
}
