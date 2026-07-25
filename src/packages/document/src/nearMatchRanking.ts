import type { NearMatchProjection, ProtectedEvidence } from "./nearMatch.js";
import { codePointLength, damerauLevenshteinCodePoints, nearMatchScore } from "./nearMatchScore.js";

// The guarded near-Note ranking policy (#713): given a target note's projection and a mathematically complete
// owner-scoped pool (already length-banded by the query), return at most five candidates that are genuinely
// similar English prose, in a stable order — writing nothing. This is the conservative review signal, so
// silence beats a false warning: an exact or case-only pair is excluded, ANY protected-evidence difference
// vetoes a pair outright, and only pairs scoring at or above the calibrated threshold survive.

// The named similarity threshold, selected ONLY on the `fixtures/card-matching/near-v1.jsonl` calibration
// split and locked by the corpus holdout gate. It is deliberately a single constant reviewed with the
// fixtures/metrics, never a per-user or per-call knob and never surfaced as a confidence score. A pair whose
// relaxed keys score below it is not a candidate.
export const NEAR_MATCH_THRESHOLD = 0.84;

// A candidate note paired with its similarity score. The score is retained for stable ordering and evidence,
// never presented to a learner as a confidence measure.
export type NearMatchCandidate<Note> = Readonly<{ note: Note; score: number }>;

// One pool entry: a note (any owner-scoped shape carrying a stable id) with its recomputed projection.
export type NearMatchPoolEntry<Note> = Readonly<{ note: Note; projection: NearMatchProjection }>;

// The most differing token positions a spelling variant may carry — the "one/two non-case edits" bound. A
// third changed word is a rewrite, not a typo.
const MAX_CHANGED_TOKENS = 2;

// The shortest word for which a single-character difference is confidently a typo rather than a different
// word. Below it, `mat`/`hat` or `cat`/`cot` are one edit apart yet plainly distinct vocabulary, so a short
// changed token is never treated as a spelling variant (this is why single-word notes are unsupported).
const MIN_VARIANT_TOKEN_LENGTH = 4;

// Whether two differing tokens are a typo-scale spelling variant of the SAME word rather than a different
// word: both at least four code points, at most two edits, and the edit no more than half the shorter token.
// `depends`/`depens` qualifies; `bear`/`born` (three edits) and `mat`/`hat` (too short) do not.
function tokensAreSpellingVariant(a: string, b: string): boolean {
  const shortest = Math.min(codePointLength(a), codePointLength(b));
  if (shortest < MIN_VARIANT_TOKEN_LENGTH) {
    return false;
  }
  const distance = damerauLevenshteinCodePoints(a, b);
  return distance <= 2 && distance * 2 <= shortest;
}

// Whether the candidate's relaxed key is a typo-scale spelling variant of the target's — the lexical guard
// that keeps spelling distance from collapsing RELATED VOCABULARY into one Note. It only judges same-length
// token material (a pure substitution/reorder): differing token counts come from spacing or an added/dropped
// word, which move enough code points that the whole-key score already separates them. For equal token
// counts, at most two positions may differ and each differing pair must be a spelling variant; a replaced
// word — even one a single character away, like `mat`/`hat` — is not, so the pair is vetoed.
function isSpellingVariant(targetKey: string, candidateKey: string): boolean {
  const targetTokens = targetKey.split(" ");
  const candidateTokens = candidateKey.split(" ");
  if (targetTokens.length !== candidateTokens.length) {
    return true;
  }
  let changed = 0;
  for (let index = 0; index < targetTokens.length; index += 1) {
    if (targetTokens[index] === candidateTokens[index]) {
      continue;
    }
    changed += 1;
    if (changed > MAX_CHANGED_TOKENS) {
      return false;
    }
    if (!tokensAreSpellingVariant(targetTokens[index]!, candidateTokens[index]!)) {
      return false;
    }
  }
  return true;
}

// Whether two notes' protected evidence differs in ANY field — numbers, symbols, negations, or identifiers.
// A single difference vetoes the pair, so spelling distance can never collapse a changed number, negation,
// operator, or acronym into a match.
function evidenceDiffers(a: ProtectedEvidence, b: ProtectedEvidence): boolean {
  return (
    a.numbers !== b.numbers ||
    a.symbols !== b.symbols ||
    a.negations !== b.negations ||
    a.identifiers !== b.identifiers
  );
}

// Whether a candidate is a non-candidate BEFORE scoring: identical exact material (the exact review owns it),
// or a case-only difference (identical relaxed key but a different case-sensitive key — there is no
// deterministic way to tell ordinary capitalization from `US`/`us`), or any protected-evidence difference, or
// a relaxed key that is not a typo-scale spelling variant (different vocabulary rather than a misspelling).
function isExcluded(target: NearMatchProjection, candidate: NearMatchProjection): boolean {
  if (candidate.exactMaterial === target.exactMaterial) {
    return true;
  }
  if (
    candidate.relaxedKey === target.relaxedKey &&
    candidate.caseSensitiveKey !== target.caseSensitiveKey
  ) {
    return true;
  }
  if (evidenceDiffers(target.protectedEvidence, candidate.protectedEvidence)) {
    return true;
  }
  return !isSpellingVariant(target.relaxedKey, candidate.relaxedKey);
}

// Rank the pool for a target projection: drop excluded pairs, score the rest on their relaxed keys, keep those
// at or above the threshold, and return the top five ordered by score descending then note id ascending — a
// total, deterministic order with no arbitrary scan cap. The caller supplies each entry's stable id via
// `noteId` so the tie-break never depends on the note's shape.
export function selectNearMatches<Note>(
  target: NearMatchProjection,
  pool: ReadonlyArray<NearMatchPoolEntry<Note>>,
  noteId: (note: Note) => string
): NearMatchCandidate<Note>[] {
  const scored: Array<{ candidate: NearMatchCandidate<Note>; id: string }> = [];
  for (const entry of pool) {
    if (isExcluded(target, entry.projection)) {
      continue;
    }
    const score = nearMatchScore(target.relaxedKey, entry.projection.relaxedKey);
    if (score >= NEAR_MATCH_THRESHOLD) {
      scored.push({ candidate: { note: entry.note, score }, id: noteId(entry.note) });
    }
  }
  scored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    // Note ids are unique within an owner-scoped pool, so a stable ascending id tie-break is total.
    return left.id < right.id ? -1 : 1;
  });
  return scored.slice(0, 5).map((entry) => entry.candidate);
}
