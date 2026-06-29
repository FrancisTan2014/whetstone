import type { EntryId } from "./entry.js";

// A note anchors to a stable block id so it survives edits and re-imports. A note may span
// several blocks (#257): `blockEntryId` is the start block, `endBlockEntryId` the end block, and
// for a single-block note the two are equal. For a sub-block or cross-block selection it records a
// character offset range — `startOffset` within the start block, `endOffset` within the end block;
// a whole single block omits both. The selected-text and surrounding-context snapshots keep the
// note legible even if the underlying blocks later change.
export type NoteAnchor = Readonly<{
  blockEntryId: EntryId;
  contextSnapshot: string;
  endBlockEntryId: EntryId;
  endOffset?: number;
  selectedTextSnapshot: string;
  startOffset?: number;
}>;

// The input tolerates explicit `undefined` offsets (e.g. from a Zod-parsed payload under
// exactOptionalPropertyTypes); the constructed anchor omits them entirely. `endBlockEntryId`
// defaults to `blockEntryId` (a single-block note) when omitted.
export type CreateNoteAnchorInput = Readonly<{
  blockEntryId: EntryId;
  contextSnapshot: string;
  endBlockEntryId?: EntryId | undefined;
  endOffset?: number | undefined;
  selectedTextSnapshot: string;
  startOffset?: number | undefined;
}>;

export function createNoteAnchor(input: CreateNoteAnchorInput): NoteAnchor {
  assertNonEmptySnapshot("selectedTextSnapshot", input.selectedTextSnapshot);
  assertNonEmptySnapshot("contextSnapshot", input.contextSnapshot);

  const endBlockEntryId = input.endBlockEntryId ?? input.blockEntryId;
  const { endOffset, startOffset } = input;

  // A cross-block span carries an offset on each end block (start offset in the start block, end
  // offset in the end block). The same-block ordering and context-containment invariants do not
  // apply across blocks, so they are only checked for a single-block note.
  if (endBlockEntryId !== input.blockEntryId) {
    if (startOffset === undefined || endOffset === undefined) {
      throw new Error("NoteAnchor cross-block span must provide startOffset and endOffset.");
    }

    assertNonNegativeInteger("startOffset", startOffset);
    assertNonNegativeInteger("endOffset", endOffset);

    return Object.freeze({
      blockEntryId: input.blockEntryId,
      contextSnapshot: input.contextSnapshot,
      endBlockEntryId,
      endOffset,
      selectedTextSnapshot: input.selectedTextSnapshot,
      startOffset
    });
  }

  if (!input.contextSnapshot.includes(input.selectedTextSnapshot)) {
    throw new Error("NoteAnchor contextSnapshot must contain selectedTextSnapshot.");
  }

  if ((startOffset === undefined) !== (endOffset === undefined)) {
    throw new Error("NoteAnchor startOffset and endOffset must be provided together.");
  }

  if (startOffset === undefined || endOffset === undefined) {
    return Object.freeze({
      blockEntryId: input.blockEntryId,
      contextSnapshot: input.contextSnapshot,
      endBlockEntryId,
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
    endBlockEntryId,
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
