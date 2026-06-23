import type { EntryId } from "./entry.js";

// A note anchors to a stable block id so it survives edits and re-imports. For
// sub-block selections it also records a character offset range within that block;
// whole-block selections omit the offsets. The selected-text and surrounding-context
// snapshots keep the note legible even if the underlying block later changes.
export type NoteAnchor = Readonly<{
  blockEntryId: EntryId;
  contextSnapshot: string;
  endOffset?: number;
  selectedTextSnapshot: string;
  startOffset?: number;
}>;

export type CreateNoteAnchorInput = NoteAnchor;

export function createNoteAnchor(input: CreateNoteAnchorInput): NoteAnchor {
  assertNonEmptySnapshot("selectedTextSnapshot", input.selectedTextSnapshot);
  assertNonEmptySnapshot("contextSnapshot", input.contextSnapshot);

  if (!input.contextSnapshot.includes(input.selectedTextSnapshot)) {
    throw new Error("NoteAnchor contextSnapshot must contain selectedTextSnapshot.");
  }

  const { endOffset, startOffset } = input;

  if ((startOffset === undefined) !== (endOffset === undefined)) {
    throw new Error("NoteAnchor startOffset and endOffset must be provided together.");
  }

  if (startOffset === undefined || endOffset === undefined) {
    return Object.freeze({
      blockEntryId: input.blockEntryId,
      contextSnapshot: input.contextSnapshot,
      selectedTextSnapshot: input.selectedTextSnapshot
    });
  }

  assertNonNegativeInteger("startOffset", startOffset);
  assertNonNegativeInteger("endOffset", endOffset);

  if (endOffset <= startOffset) {
    throw new Error("NoteAnchor endOffset must be greater than startOffset.");
  }

  return Object.freeze({
    blockEntryId: input.blockEntryId,
    contextSnapshot: input.contextSnapshot,
    endOffset,
    selectedTextSnapshot: input.selectedTextSnapshot,
    startOffset
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
