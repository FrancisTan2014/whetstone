import damerauLevenshtein from "talisman/metrics/damerau-levenshtein.js";

import type { AuthorId } from "./author.js";
import type { EntryId } from "./entry.js";
import type { WorkLanguage, WorkType } from "./work.js";

// #724 Work duplicate-candidate scoring — the pure heart of the server-owned normalization and scoring
// boundary. Metadata similarity is candidate EVIDENCE, never Work identity: this module reads proposed
// metadata plus a pre-filtered pool of existing Works and returns a small, deterministic, factual review
// set. It writes nothing, merges nothing, and never labels a row a duplicate. Title normalization itself
// lives in the database (`work_title_key`), so the caller passes already-normalized title keys in — this
// module never re-implements Unicode lowercasing in JavaScript.

// Title similarity is normalized Damerau-Levenshtein over the canonical title keys: `1 - distance/maxLen`,
// where length is measured in CODE POINTS so a multi-code-unit character counts as one edit — matching the
// `char_length` the SQL prefilter uses on the same keys, which keeps the bounded pool provably complete.
export function titleKeySimilarity(a: string, b: string): number {
  const codePointsA = Array.from(a);
  const codePointsB = Array.from(b);
  const maxLength = Math.max(codePointsA.length, codePointsB.length);

  // Both keys are non-blank in practice (the SQL function fails loud on a blank key), but guard the empty
  // case so the pure function is total rather than dividing by zero.
  if (maxLength === 0) {
    return 1;
  }

  return 1 - damerauLevenshtein(codePointsA, codePointsB) / maxLength;
}

// The similarity a same-author fuzzy match must reach. Same author is corroborating evidence, so the bar is
// lower than for a different author.
export const SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD = 0.87;

// The (stricter) similarity a different-author fuzzy match must reach: without the author signal, only a
// nearly identical title is credible evidence.
export const DIFFERENT_AUTHOR_TITLE_SIMILARITY_THRESHOLD = 0.94;

// At most five candidates are returned; the caller logs how many credible candidates existed in total.
export const MAX_WORK_DUPLICATE_CANDIDATES = 5;

// The inclusive title-key length window a candidate must fall in to POSSIBLY reach any tier's similarity.
// Damerau-Levenshtein distance is at least the length difference `||a| - |b||`, and similarity uses
// `maxLen` as the denominator, so for the most permissive threshold `t` (same author, 0.87):
//   - a shorter candidate (`Lb <= La`) needs `La - Lb <= (1-t)*La`, i.e. `Lb >= t*La`;
//   - a longer candidate (`Lb >= La`) needs `Lb - La <= (1-t)*Lb`, i.e. `Lb <= La/t`.
// `floor`/`ceil` widen the window outward, so the pool is a guaranteed SUPERSET of every possible match
// (mathematically complete) while staying bounded. Exact per-tier thresholds are applied afterwards.
export function candidateTitleKeyLengthBounds(
  proposedTitleKeyLength: number
): Readonly<{ minLength: number; maxLength: number }> {
  const threshold = SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD;

  return {
    minLength: Math.floor(proposedTitleKeyLength * threshold),
    maxLength: Math.ceil(proposedTitleKeyLength / threshold)
  };
}

// A conservative, closed vocabulary of edition/printing keywords recognized inside a normalized title key
// (whitespace-stripped, lowercased). Purely factual: it surfaces recognized tokens one title carries and
// the other does not, so a reviewer can see WHY two similar titles differ. It never strips punctuation and
// never asserts a duplicate.
const editionKeywordMarkers = [
  "revised",
  "expanded",
  "annotated",
  "illustrated",
  "deluxe",
  "anniversary",
  "reprint"
] as const;

const ordinalEditionPattern = /(\d+)(?:st|nd|rd|th)(?:edition|ed)/g;

function extractEditionMarkers(titleKey: string): ReadonlySet<string> {
  const markers = new Set<string>();

  for (const keyword of editionKeywordMarkers) {
    if (titleKey.includes(keyword)) {
      markers.add(keyword);
    }
  }

  // "unabridged" contains "abridged", so resolve the longer, opposite marker first to avoid reporting both.
  if (titleKey.includes("unabridged")) {
    markers.add("unabridged");
  } else if (titleKey.includes("abridged")) {
    markers.add("abridged");
  }

  for (const match of titleKey.matchAll(ordinalEditionPattern)) {
    markers.add(`edition:${Number(match[1])}`);
  }

  return markers;
}

// The factual reasons a candidate is surfaced. No reason ever claims the row IS a duplicate; the learner
// decides.
export type DuplicateCandidateEvidence = Readonly<{
  sameAuthor: boolean;
  titleSimilarity: number;
  languageDiffers: boolean;
  workTypeDiffers: boolean;
  editionMarkerDifferences: ReadonlyArray<string>;
}>;

// Why a candidate qualified, ordered from strongest to weakest: an exact title-key match (any author),
// then a same-author fuzzy match, then a cross-author fuzzy match.
export type WorkDuplicateMatchTier = "exact" | "same_author_fuzzy" | "cross_author_fuzzy";

const matchTierRank: Readonly<Record<WorkDuplicateMatchTier, number>> = {
  exact: 0,
  same_author_fuzzy: 1,
  cross_author_fuzzy: 2
};

// The proposed metadata under review. `titleKey` is the database-computed canonical key (never recomputed
// here); `authorId` identifies the chosen/created author so same-author corroboration is exact, not fuzzy.
// `authorId` is `null` when the learner typed a BRAND-NEW author name that matches no existing Library
// identity (#747): such a proposal has no author row yet (it is created only inside the final Work
// transaction), so it can never be the same author as an existing Work — same-author corroboration is
// impossible and only the stricter cross-author title bar applies. Author names are never fuzzy-matched.
export type ProposedWorkMetadata = Readonly<{
  titleKey: string;
  authorId: AuthorId | null;
  language: WorkLanguage;
  workType: WorkType;
}>;

// One existing Work in the pre-filtered pool. `origin` is intentionally absent: excluding authored Works is
// the server query's responsibility (it never loads them), so this pure function trusts the pool it is given.
export type ExistingWorkCandidate = Readonly<{
  entryId: EntryId;
  title: string;
  titleKey: string;
  authorId: AuthorId;
  authorName: string;
  language: WorkLanguage;
  workType: WorkType;
}>;

// A qualifying candidate with its display fields and factual evidence.
export type WorkDuplicateCandidate = Readonly<{
  entryId: EntryId;
  title: string;
  author: Readonly<{ id: AuthorId; name: string }>;
  language: WorkLanguage;
  workType: WorkType;
  matchTier: WorkDuplicateMatchTier;
  evidence: DuplicateCandidateEvidence;
}>;

// The complete review set: up to five candidates, plus the total number that qualified (so the caller can
// log how many credible candidates existed even when only five are returned).
export type WorkDuplicateCandidateResult = Readonly<{
  candidates: ReadonlyArray<WorkDuplicateCandidate>;
  totalCandidateCount: number;
}>;

function classifyMatch(
  proposed: ProposedWorkMetadata,
  candidate: ExistingWorkCandidate,
  sameAuthor: boolean,
  similarity: number
): WorkDuplicateMatchTier | undefined {
  if (candidate.titleKey === proposed.titleKey) {
    return "exact";
  }

  if (sameAuthor) {
    return similarity >= SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD ? "same_author_fuzzy" : undefined;
  }

  return similarity >= DIFFERENT_AUTHOR_TITLE_SIMILARITY_THRESHOLD
    ? "cross_author_fuzzy"
    : undefined;
}

// Score a pre-filtered pool of existing Works against proposed metadata and return the ranked review set.
// Deterministic: candidates are sorted by tier (exact, then same-author fuzzy, then cross-author fuzzy),
// then by title similarity descending, then by Work id ascending, and capped at five.
export function selectWorkDuplicateCandidates(
  proposed: ProposedWorkMetadata,
  pool: ReadonlyArray<ExistingWorkCandidate>
): WorkDuplicateCandidateResult {
  const proposedEditionMarkers = extractEditionMarkers(proposed.titleKey);
  const qualified: Array<Readonly<{ candidate: WorkDuplicateCandidate; similarity: number }>> = [];

  for (const candidate of pool) {
    // A brand-new author (`authorId === null`) has no existing identity, so it is never the same author as
    // any stored Work — only the stricter cross-author title bar can qualify a candidate.
    const sameAuthor = proposed.authorId !== null && candidate.authorId === proposed.authorId;
    const similarity =
      candidate.titleKey === proposed.titleKey
        ? 1
        : titleKeySimilarity(proposed.titleKey, candidate.titleKey);
    const matchTier = classifyMatch(proposed, candidate, sameAuthor, similarity);

    if (matchTier === undefined) {
      continue;
    }

    const candidateEditionMarkers = extractEditionMarkers(candidate.titleKey);
    const editionMarkerDifferences = symmetricDifference(
      proposedEditionMarkers,
      candidateEditionMarkers
    );

    qualified.push({
      similarity,
      candidate: {
        entryId: candidate.entryId,
        title: candidate.title,
        author: { id: candidate.authorId, name: candidate.authorName },
        language: candidate.language,
        workType: candidate.workType,
        matchTier,
        evidence: {
          sameAuthor,
          titleSimilarity: similarity,
          languageDiffers: candidate.language !== proposed.language,
          workTypeDiffers: candidate.workType !== proposed.workType,
          editionMarkerDifferences
        }
      }
    });
  }

  qualified.sort((left, right) => {
    const tierDelta =
      matchTierRank[left.candidate.matchTier] - matchTierRank[right.candidate.matchTier];

    if (tierDelta !== 0) {
      return tierDelta;
    }

    if (left.similarity !== right.similarity) {
      return right.similarity - left.similarity;
    }

    return left.candidate.entryId < right.candidate.entryId ? -1 : 1;
  });

  return {
    candidates: qualified.slice(0, MAX_WORK_DUPLICATE_CANDIDATES).map((entry) => entry.candidate),
    totalCandidateCount: qualified.length
  };
}

function symmetricDifference(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): ReadonlyArray<string> {
  const difference: string[] = [];

  for (const value of a) {
    if (!b.has(value)) {
      difference.push(value);
    }
  }

  for (const value of b) {
    if (!a.has(value)) {
      difference.push(value);
    }
  }

  return difference.sort();
}
