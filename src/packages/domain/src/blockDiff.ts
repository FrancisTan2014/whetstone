// Content-similarity diff between a work's existing blocks and a freshly decomposed
// source, used on re-ingestion to preserve stable block ids. Matching is order
// preserving (longest common subsequence) with a fuzzy equality predicate so that
// unchanged AND lightly-edited blocks keep their id, genuinely new blocks get a new
// id, and removed blocks are reported for soft-deletion. Reordering is treated as
// remove + add in v0; ids are preserved across inserts, deletes, and edits.

export type DiffOldBlock = Readonly<{ id: string; plaintext: string }>;

export type DiffNewBlock = Readonly<{ plaintext: string }>;

export type BlockDiff = Readonly<{
  // One entry per new block, in order: the existing id to preserve, or undefined when
  // the block is genuinely new.
  assignments: ReadonlyArray<string | undefined>;
  // Existing block ids that no new block matched; these should be soft-deleted.
  removedIds: ReadonlyArray<string>;
}>;

// A block counts as "the same block, possibly lightly edited" at or above this
// Sørensen–Dice bigram similarity. Tuned so small wording/punctuation edits match
// while unrelated text does not.
const similarityThreshold = 0.6;

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }

  return counts;
}

// Sørensen–Dice coefficient over character bigrams of the normalized text. Identical
// text scores 1; strings too short for bigrams fall back to exact equality.
export function blockSimilarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);

  if (left === right) {
    return 1;
  }

  if (left.length < 2 || right.length < 2) {
    return 0;
  }

  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let shared = 0;

  for (const [pair, leftCount] of leftBigrams) {
    const rightCount = rightBigrams.get(pair);

    if (rightCount !== undefined) {
      shared += Math.min(leftCount, rightCount);
    }
  }

  return (2 * shared) / (left.length - 1 + (right.length - 1));
}

function matches(oldBlock: DiffOldBlock, newBlock: DiffNewBlock): boolean {
  return blockSimilarity(oldBlock.plaintext, newBlock.plaintext) >= similarityThreshold;
}

export function diffBlocks(
  oldBlocks: ReadonlyArray<DiffOldBlock>,
  newBlocks: ReadonlyArray<DiffNewBlock>
): BlockDiff {
  const oldCount = oldBlocks.length;
  const newCount = newBlocks.length;
  const width = newCount + 1;
  const lengths = new Int32Array((oldCount + 1) * width);
  const oldAt = (index: number): DiffOldBlock => oldBlocks[index] as DiffOldBlock;
  const newAt = (index: number): DiffNewBlock => newBlocks[index] as DiffNewBlock;
  const lengthAt = (a: number, b: number): number => lengths[a * width + b] as number;

  for (let i = oldCount - 1; i >= 0; i -= 1) {
    for (let j = newCount - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = matches(oldAt(i), newAt(j))
        ? lengthAt(i + 1, j + 1) + 1
        : Math.max(lengthAt(i + 1, j), lengthAt(i, j + 1));
    }
  }

  const assignments = new Array<string | undefined>(newCount).fill(undefined);
  const matchedOld = new Set<number>();
  let i = 0;
  let j = 0;

  while (i < oldCount && j < newCount) {
    if (matches(oldAt(i), newAt(j))) {
      assignments[j] = oldAt(i).id;
      matchedOld.add(i);
      i += 1;
      j += 1;
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const removedIds = oldBlocks
    .filter((_, index) => !matchedOld.has(index))
    .map((block) => block.id);

  return Object.freeze({
    assignments: Object.freeze(assignments),
    removedIds: Object.freeze(removedIds)
  });
}
