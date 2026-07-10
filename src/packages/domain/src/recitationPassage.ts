// Recitation passage practice (#578): the pure vocabulary and segmentation logic for dividing a
// recitation Work (a plan a learner recites, #577) into contiguous passages, cueing an attempt, mapping
// a self-assessment onto an FSRS rating, and re-anchoring a passage when the source text drifts. No
// persistence, scheduling maths, DB, network, or UI — time and the FSRS schedule enter elsewhere. The
// canonical Work text is never changed here: passages only describe ranges over it.

import type { ReviewRating } from "./fsrs.js";

// A contiguous source range within a Work: from `startOffset` in `startBlockEntryId` to `endOffset` in
// `endBlockEntryId`. A single-block passage has equal block ids; offsets index a block's plaintext,
// byte-aligned with the reader's rendered text exactly as note anchors are (#344). The range is a
// half-open [start, end) span so adjacent passages meet without overlapping.
export type PassageRange = Readonly<{
  startBlockEntryId: string;
  startOffset: number;
  endBlockEntryId: string;
  endOffset: number;
}>;

// One Work text block in source order: its addressable id and its plaintext. Segmentation reads the
// ordered block list as the canonical layout; it never mutates it.
export type PassageBlock = Readonly<{ blockEntryId: string; text: string }>;

// The two restrained cues a due review can open with (#578). `preceding_line` shows only the final line
// of the passage before this one (pure lead-in context, nothing of the target); `opening` shows the
// target's first few characters (a stronger nudge). Neither reveals the full target — that waits for an
// explicit Reveal. The order is weakest-context to strongest-nudge so a learner can step the cue up.
export const recitationCueStrengths = ["preceding_line", "opening"] as const;

export type RecitationCueStrength = (typeof recitationCueStrengths)[number];

const cueStrengthSet: ReadonlySet<unknown> = new Set(recitationCueStrengths);

export function isRecitationCueStrength(value: unknown): value is RecitationCueStrength {
  return cueStrengthSet.has(value);
}

// How many leading characters the `opening` cue reveals, and how many trailing characters of the
// preceding passage's final line the `preceding_line` cue keeps — both deliberately small so the cue
// stays restrained (the Outcome: "attempt one from a restrained cue").
export const OPENING_CUE_CHARS = 6;
export const PRECEDING_LINE_MAX_CHARS = 24;

// The final line of the preceding passage's text, capped to a restrained tail. Empty when there is no
// preceding passage (the first passage of the Work) — the review then opens on `opening` context only.
function precedingLineCue(precedingText: string | null): string {
  if (precedingText === null) {
    return "";
  }
  const lines = precedingText.split("\n");
  // split always yields at least one element, so the final line is present.
  const finalLine = lines[lines.length - 1]!.trim();
  return finalLine.slice(Math.max(0, finalLine.length - PRECEDING_LINE_MAX_CHARS));
}

// The cue text to show before an attempt, for the chosen strength. `preceding_line` → the preceding
// passage's final line (restrained); `opening` → the target's first `OPENING_CUE_CHARS`. Pure: the full
// target is never returned here, so a cue can never leak the answer the learner is meant to produce.
export function passageCueText(
  strength: RecitationCueStrength,
  targetText: string,
  precedingText: string | null
): string {
  if (strength === "opening") {
    return targetText.slice(0, OPENING_CUE_CHARS);
  }
  return precedingLineCue(precedingText);
}

// The four self-assessment choices, ordered easiest-failure to cleanest, each mapped to the FSRS rating
// it schedules (#572). This is product copy owned by the domain so the DTO/UI never invents a fifth
// button or drifts a mapping: `Couldn't continue`→again, `Needed cues`→hard, `Complete, with
// effort`→good, `Clean and natural`→easy.
export const recitationRatingChoices = [
  { label: "Couldn't continue", rating: "again" },
  { label: "Needed cues", rating: "hard" },
  { label: "Complete, with effort", rating: "good" },
  { label: "Clean and natural", rating: "easy" }
] as const satisfies ReadonlyArray<{ label: string; rating: ReviewRating }>;

// Whether a passage's source range still faithfully covers the current Work text, or has drifted and
// must be repaired before it is practised again — a passage never silently practises stale/wrong text.
export const passageAnchorStatuses = ["anchored", "needs_repair"] as const;

export type PassageAnchorStatus = (typeof passageAnchorStatuses)[number];

// A stable ordering key for a position (block, offset) within the Work, using each block's source order.
function positionKey(order: ReadonlyMap<string, number>, blockEntryId: string, offset: number): number {
  const blockIndex = order.get(blockEntryId);
  return blockIndex === undefined ? Number.NaN : blockIndex;
}

function orderOf(blocks: readonly PassageBlock[]): ReadonlyMap<string, number> {
  return new Map(blocks.map((block, index) => [block.blockEntryId, index] as const));
}

// The exact source text a range covers, joining block slices with a newline between blocks (so a
// multi-block passage reads as separate lines). Returns null when a referenced block is absent from the
// layout (a deleted block) — the caller treats that as drift needing repair.
export function coveredPassageText(
  range: PassageRange,
  blockTextById: ReadonlyMap<string, string>
): string | null {
  const startText = blockTextById.get(range.startBlockEntryId);
  const endText = blockTextById.get(range.endBlockEntryId);
  if (startText === undefined || endText === undefined) {
    return null;
  }
  if (range.startBlockEntryId === range.endBlockEntryId) {
    return startText.slice(range.startOffset, range.endOffset);
  }
  return `${startText.slice(range.startOffset)}\n${endText.slice(0, range.endOffset)}`;
}

// Seed one passage per non-empty Work text block, spanning the whole block, in source order. Blocks
// whose text is blank (whitespace only) are skipped — a heading/blank never seeds a passage. This is the
// initial segmentation a learner then splits and merges.
export function seedPassageRanges(blocks: readonly PassageBlock[]): PassageRange[] {
  return blocks
    .filter((block) => block.text.trim().length > 0)
    .map((block) => ({
      endBlockEntryId: block.blockEntryId,
      endOffset: block.text.length,
      startBlockEntryId: block.blockEntryId,
      startOffset: 0
    }));
}

export type SplitInvalidReason = "unknown_block" | "out_of_range" | "at_boundary";

export type SplitPassageResult =
  | Readonly<{ status: "split"; first: PassageRange; second: PassageRange }>
  | Readonly<{ status: "invalid"; reason: SplitInvalidReason }>;

// Split a passage at a text position into two contiguous passages, without changing the Work text. The
// split point must lie strictly inside the passage (not at either boundary) and reference a block the
// passage covers — otherwise the split is rejected with a reason. The two halves meet exactly at the
// split point, so together they still tile the original range.
export function splitPassageRange(
  blocks: readonly PassageBlock[],
  passage: PassageRange,
  at: Readonly<{ blockEntryId: string; offset: number }>
): SplitPassageResult {
  const order = orderOf(blocks);
  const atIndex = positionKey(order, at.blockEntryId, at.offset);
  const startIndex = positionKey(order, passage.startBlockEntryId, passage.startOffset);
  const endIndex = positionKey(order, passage.endBlockEntryId, passage.endOffset);
  if (Number.isNaN(atIndex) || Number.isNaN(startIndex) || Number.isNaN(endIndex)) {
    return { reason: "unknown_block", status: "invalid" };
  }

  // atIndex is a real index into `blocks` (its NaN case was rejected above).
  const blockText = blocks[atIndex]!.text;
  if (at.offset < 0 || at.offset > blockText.length) {
    return { reason: "out_of_range", status: "invalid" };
  }

  // Reject a split that lands outside the passage's covered span, or exactly on either endpoint (which
  // would produce an empty half).
  const beforeStart = atIndex < startIndex || (atIndex === startIndex && at.offset <= passage.startOffset);
  const afterEnd = atIndex > endIndex || (atIndex === endIndex && at.offset >= passage.endOffset);
  if (beforeStart || afterEnd) {
    return { reason: "at_boundary", status: "invalid" };
  }

  return {
    first: {
      endBlockEntryId: at.blockEntryId,
      endOffset: at.offset,
      startBlockEntryId: passage.startBlockEntryId,
      startOffset: passage.startOffset
    },
    second: {
      endBlockEntryId: passage.endBlockEntryId,
      endOffset: passage.endOffset,
      startBlockEntryId: at.blockEntryId,
      startOffset: at.offset
    },
    status: "split"
  };
}

export type MergePassagesResult =
  | Readonly<{ status: "merged"; range: PassageRange }>
  | Readonly<{ status: "invalid"; reason: "not_adjacent" }>;

// Merge two adjacent passages into one, without changing the Work text. `earlier` must end exactly where
// `later` begins (same block and offset); otherwise the merge is rejected. The merged range spans from
// the earlier start to the later end.
export function mergePassageRanges(
  earlier: PassageRange,
  later: PassageRange
): MergePassagesResult {
  const adjacent =
    earlier.endBlockEntryId === later.startBlockEntryId &&
    earlier.endOffset === later.startOffset;
  if (!adjacent) {
    return { reason: "not_adjacent", status: "invalid" };
  }
  return {
    range: {
      endBlockEntryId: later.endBlockEntryId,
      endOffset: later.endOffset,
      startBlockEntryId: earlier.startBlockEntryId,
      startOffset: earlier.startOffset
    },
    status: "merged"
  };
}

// A passage as stored for re-anchoring: its current range plus the exact source text captured when it
// was last anchored, so drift can be detected against the live block text.
export type AnchoredPassage = Readonly<{ range: PassageRange; sourceText: string }>;

export type ReanchorOutcome =
  | Readonly<{ status: "unchanged" }>
  | Readonly<{ status: "relocated"; range: PassageRange }>
  | Readonly<{ status: "needs_repair" }>;

// Re-anchor a passage against the current Work text after a source edit. Unchanged when the live text at
// the stored range still equals the captured source. Otherwise, for a single-block passage, relocate to
// the first occurrence of the captured source in the block's new text. When the text is gone, the block
// was deleted, or the passage spans multiple blocks that drifted, it `needs_repair` — never silently
// practising stale or wrong text (#578). An empty captured source never matches, so it needs repair.
export function reanchorPassageRange(
  passage: AnchoredPassage,
  blockTextById: ReadonlyMap<string, string>
): ReanchorOutcome {
  const covered = coveredPassageText(passage.range, blockTextById);
  if (covered !== null && covered === passage.sourceText) {
    return { status: "unchanged" };
  }

  const singleBlock = passage.range.startBlockEntryId === passage.range.endBlockEntryId;
  const blockText = blockTextById.get(passage.range.startBlockEntryId);
  if (!singleBlock || blockText === undefined || passage.sourceText.length === 0) {
    return { status: "needs_repair" };
  }

  const index = blockText.indexOf(passage.sourceText);
  if (index < 0) {
    return { status: "needs_repair" };
  }

  return {
    range: {
      endBlockEntryId: passage.range.startBlockEntryId,
      endOffset: index + passage.sourceText.length,
      startBlockEntryId: passage.range.startBlockEntryId,
      startOffset: index
    },
    status: "relocated"
  };
}
