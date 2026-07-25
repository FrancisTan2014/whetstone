// The readable, factual word-level difference between a drafted note and one near-match candidate (#714).
// Near matching (#713) only ever surfaces typo-scale spelling variants and spacing/added-or-dropped-word
// pairs whose protected evidence is identical, so the two case-sensitive relaxed keys differ in a handful of
// word positions. This pure derivation turns that into a small ordered list of concrete word changes the
// review panel shows as evidence — never a similarity score and never a "duplicate" verdict. Like every
// near-match projection it is deterministic and browser-safe, so the server computes it once and React only
// renders it.

// One concrete word-level change between the existing candidate note and the drafted answer: the candidate's
// wording (`before`) against the draft's (`after`). An empty `before` is a word the draft added; an empty
// `after` is a word the candidate has that the draft dropped. A pair with both sides non-empty is a changed
// word (e.g. `terms` → `term`).
export type NearMatchDifference = Readonly<{ before: string; after: string }>;

// Split a normalized case-sensitive key into its space-separated word tokens. An empty key yields no tokens
// (never a single empty token), so a diff against an empty side reads as pure additions.
function tokenize(key: string): string[] {
  return key.length === 0 ? [] : key.split(" ");
}

// The index pairs of a longest common subsequence of two token arrays, in order — the words that are shared
// and aligned between the candidate and the draft. Everything between two consecutive shared words (or the
// ends) is a change hunk. The arrays are tiny (near-eligible keys hold at most 40 tokens), so the quadratic
// table is trivial.
function commonSubsequence(before: string[], after: string[]): Array<readonly [number, number]> {
  const rows = before.length;
  const cols = after.length;
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const matches: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

// Describe how a near-match candidate's wording differs from the drafted answer as an ordered list of concise
// word changes. `before` is the candidate's normalized case-sensitive key; `after` is the draft's. Each hunk
// collapses a run of differing words between two shared words into one `{ before, after }` segment, so a
// changed word, an added word, and a dropped word each read as a single factual difference. Two identical
// keys yield an empty list (there is nothing to compare — the exclusion policy already handled exact and
// case-only pairs upstream).
export function describeNearMatchDifferences(before: string, after: string): NearMatchDifference[] {
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const matches = commonSubsequence(beforeTokens, afterTokens);

  const differences: NearMatchDifference[] = [];
  let beforeCursor = 0;
  let afterCursor = 0;
  for (const [beforeIndex, afterIndex] of [
    ...matches,
    [beforeTokens.length, afterTokens.length] as const
  ]) {
    const removed = beforeTokens.slice(beforeCursor, beforeIndex);
    const added = afterTokens.slice(afterCursor, afterIndex);
    if (removed.length > 0 || added.length > 0) {
      differences.push({ after: added.join(" "), before: removed.join(" ") });
    }
    beforeCursor = beforeIndex + 1;
    afterCursor = afterIndex + 1;
  }
  return differences;
}
