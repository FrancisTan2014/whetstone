import { toAuthorId, toEntryId } from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import {
  candidateTitleKeyLengthBounds,
  DIFFERENT_AUTHOR_TITLE_SIMILARITY_THRESHOLD,
  MAX_WORK_DUPLICATE_CANDIDATES,
  SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD,
  selectWorkDuplicateCandidates,
  titleKeySimilarity,
  type ExistingWorkCandidate,
  type ProposedWorkMetadata
} from "./workDuplicateCandidates.js";

const AUTHOR_A = toAuthorId("author-a");
const AUTHOR_B = toAuthorId("author-b");

function proposal(overrides: Partial<ProposedWorkMetadata> = {}): ProposedWorkMetadata {
  return {
    titleKey: "cleancode",
    authorId: AUTHOR_A,
    language: "en",
    workType: "book",
    ...overrides
  };
}

function candidate(overrides: Partial<ExistingWorkCandidate> = {}): ExistingWorkCandidate {
  return {
    entryId: toEntryId("work-1"),
    title: "Clean Code",
    titleKey: "cleancode",
    authorId: AUTHOR_A,
    authorName: "Robert C. Martin",
    language: "en",
    workType: "book",
    ...overrides
  };
}

describe("titleKeySimilarity", () => {
  it("scores identical keys as a perfect match", () => {
    expect(titleKeySimilarity("cleancode", "cleancode")).toBe(1);
  });

  it("treats two empty keys as identical (total, never divides by zero)", () => {
    expect(titleKeySimilarity("", "")).toBe(1);
  });

  it("counts an adjacent transposition as a single Damerau edit, not two", () => {
    // Plain Levenshtein would score this 0 (two substitutions); Damerau-Levenshtein scores one transposition.
    expect(titleKeySimilarity("ba", "ab")).toBeCloseTo(0.5, 5);
  });

  it("measures similarity in code points so a CJK character counts as one edit", () => {
    // Two three-character Chinese titles differing in the final glyph: one edit over three code points.
    expect(titleKeySimilarity("深入理解", "深入理x")).toBeCloseTo(0.75, 5);
  });

  it("keeps preserved punctuation as real edits (C++ Primer vs C Primer stay distinct)", () => {
    // Keys "c++primer" (9) and "cprimer" (7) differ by deleting two '+', below every threshold.
    const similarity = titleKeySimilarity("c++primer", "cprimer");
    expect(similarity).toBeCloseTo(1 - 2 / 9, 5);
    expect(similarity).toBeLessThan(SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD);
  });
});

describe("candidateTitleKeyLengthBounds", () => {
  it("widens the window outward from the most permissive (same-author) threshold", () => {
    // 20 * 0.87 = 17.4 -> floor 17; 20 / 0.87 = 22.98 -> ceil 23.
    expect(candidateTitleKeyLengthBounds(20)).toEqual({ minLength: 17, maxLength: 23 });
  });

  it("is a complete superset: every key that could reach the threshold falls inside", () => {
    const proposedLength = 30;
    const { minLength, maxLength } = candidateTitleKeyLengthBounds(proposedLength);
    const base = "x".repeat(proposedLength);

    // A candidate shorter or longer than the window cannot reach 0.87, so excluding it loses no match.
    const justInsideShort = "x".repeat(minLength);
    const justInsideLong = "x".repeat(maxLength);
    expect(titleKeySimilarity(base, justInsideShort)).toBeGreaterThanOrEqual(
      SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD - 0.02
    );
    expect(titleKeySimilarity(base, "x".repeat(minLength - 1))).toBeLessThan(
      SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD
    );
    expect(titleKeySimilarity(base, "x".repeat(maxLength + 1))).toBeLessThan(
      SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD
    );
    expect(justInsideLong.length).toBe(maxLength);
  });
});

describe("selectWorkDuplicateCandidates", () => {
  it("returns an empty, zero-count result for an empty pool", () => {
    expect(selectWorkDuplicateCandidates(proposal(), [])).toEqual({
      candidates: [],
      totalCandidateCount: 0
    });
  });

  it("classifies an exact title-key match as the top tier for both same and different authors", () => {
    const result = selectWorkDuplicateCandidates(proposal(), [
      candidate({ entryId: toEntryId("work-a"), authorId: AUTHOR_A }),
      candidate({ entryId: toEntryId("work-b"), authorId: AUTHOR_B, authorName: "Someone Else" })
    ]);

    expect(result.totalCandidateCount).toBe(2);
    expect(result.candidates.map((row) => row.matchTier)).toEqual(["exact", "exact"]);
    const sameAuthorByEntry = new Map(
      result.candidates.map((row) => [row.entryId, row.evidence.sameAuthor])
    );
    expect(result.candidates[0]?.evidence.titleSimilarity).toBe(1);
    expect(sameAuthorByEntry.get(toEntryId("work-a"))).toBe(true);
    expect(sameAuthorByEntry.get(toEntryId("work-b"))).toBe(false);
  });

  it("applies the same-author threshold: 0.875 qualifies, 0.857 does not", () => {
    const included = selectWorkDuplicateCandidates(proposal({ titleKey: "abcdefgh" }), [
      candidate({ entryId: toEntryId("w-in"), titleKey: "abcdefgx" }) // 1 edit / 8 = 0.875
    ]);
    expect(included.candidates.map((row) => row.matchTier)).toEqual(["same_author_fuzzy"]);

    const excluded = selectWorkDuplicateCandidates(proposal({ titleKey: "abcdefg" }), [
      candidate({ entryId: toEntryId("w-out"), titleKey: "abcdefx" }) // 1 edit / 7 = 0.857
    ]);
    expect(excluded).toEqual({ candidates: [], totalCandidateCount: 0 });
  });

  it("requires the stricter threshold for a different author (0.90 qualifies same-author, not cross)", () => {
    // "cleancode" -> "cleancoder": one insertion over 10 = 0.90.
    const sameAuthor = selectWorkDuplicateCandidates(proposal(), [
      candidate({ entryId: toEntryId("w-same"), titleKey: "cleancoder" })
    ]);
    expect(sameAuthor.candidates.map((row) => row.matchTier)).toEqual(["same_author_fuzzy"]);

    const crossAuthor = selectWorkDuplicateCandidates(proposal(), [
      candidate({ entryId: toEntryId("w-cross"), titleKey: "cleancoder", authorId: AUTHOR_B })
    ]);
    expect(crossAuthor).toEqual({ candidates: [], totalCandidateCount: 0 });
  });

  it("qualifies a different author only at or above the cross-author threshold", () => {
    // 17-char key with a single substitution: 1 - 1/17 = 0.941 >= 0.94.
    const key = "abcdefghijklmnopq";
    const near = "abcdefghijklmnopX".toLowerCase();
    const included = selectWorkDuplicateCandidates(proposal({ titleKey: key }), [
      candidate({ entryId: toEntryId("w-x"), titleKey: near, authorId: AUTHOR_B })
    ]);
    expect(included.candidates[0]?.matchTier).toBe("cross_author_fuzzy");
    expect(titleKeySimilarity(key, near)).toBeGreaterThanOrEqual(
      DIFFERENT_AUTHOR_TITLE_SIMILARITY_THRESHOLD
    );

    // 16-char key with one substitution: 1 - 1/16 = 0.9375 < 0.94, so a different author is excluded.
    const shortKey = "abcdefghijklmnop";
    const shortNear = "abcdefghijklmnoX".toLowerCase();
    const excluded = selectWorkDuplicateCandidates(proposal({ titleKey: shortKey }), [
      candidate({ entryId: toEntryId("w-y"), titleKey: shortNear, authorId: AUTHOR_B })
    ]);
    expect(excluded).toEqual({ candidates: [], totalCandidateCount: 0 });
  });

  it("ranks exact over same-author fuzzy over cross-author fuzzy", () => {
    const key = "abcdefghijklmnopq";
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: key }), [
      candidate({
        entryId: toEntryId("w-cross"),
        titleKey: "abcdefghijklmnopx",
        authorId: AUTHOR_B
      }),
      candidate({ entryId: toEntryId("w-same-fuzzy"), titleKey: "abcdefghijklmnopr" }),
      candidate({ entryId: toEntryId("w-exact"), titleKey: key })
    ]);

    expect(result.candidates.map((row) => row.entryId)).toEqual([
      "w-exact",
      "w-same-fuzzy",
      "w-cross"
    ]);
    expect(result.candidates.map((row) => row.matchTier)).toEqual([
      "exact",
      "same_author_fuzzy",
      "cross_author_fuzzy"
    ]);
  });

  it("breaks ties by score descending, then by Work id ascending", () => {
    // All same tier (exact) and identical score; only Work id ascending decides the order.
    const result = selectWorkDuplicateCandidates(proposal(), [
      candidate({ entryId: toEntryId("w3") }),
      candidate({ entryId: toEntryId("w1") }),
      candidate({ entryId: toEntryId("w2") })
    ]);
    expect(result.candidates.map((row) => row.entryId)).toEqual(["w1", "w2", "w3"]);
  });

  it("orders same-tier candidates by title similarity descending", () => {
    // Both same-author fuzzy over a 16-code-point key: a nearer title (higher score) ranks first, even when
    // its Work id would otherwise sort later, so score dominates the id tie-break within a tier.
    const base = "abcdefghijklmnop";
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ entryId: toEntryId("w-far"), titleKey: "abcdefghijklmnXY" }), // 2 edits / 16 = 0.875
      candidate({ entryId: toEntryId("w-near"), titleKey: "abcdefghijklmnoX" }) // 1 edit / 16 = 0.9375
    ]);

    expect(result.candidates.map((row) => row.entryId)).toEqual(["w-near", "w-far"]);
    expect(result.candidates.map((row) => row.matchTier)).toEqual([
      "same_author_fuzzy",
      "same_author_fuzzy"
    ]);
    expect(result.candidates[0]?.evidence.titleSimilarity).toBeGreaterThan(
      result.candidates[1]?.evidence.titleSimilarity ?? 0
    );
  });

  it("returns at most five candidates while reporting the full qualified count", () => {
    const pool = Array.from({ length: 7 }, (_, index) =>
      candidate({ entryId: toEntryId(`w-${index}`), authorId: toAuthorId(`author-${index}`) })
    );
    const result = selectWorkDuplicateCandidates(proposal(), pool);

    expect(result.totalCandidateCount).toBe(7);
    expect(result.candidates).toHaveLength(MAX_WORK_DUPLICATE_CANDIDATES);
    expect(result.candidates.map((row) => row.entryId)).toEqual([
      "w-0",
      "w-1",
      "w-2",
      "w-3",
      "w-4"
    ]);
  });

  it("reports language and work-type differences as factual evidence on an exact match", () => {
    const result = selectWorkDuplicateCandidates(proposal(), [
      candidate({ language: "zh-CN", workType: "essay" })
    ]);
    const evidence = result.candidates[0]?.evidence;
    expect(evidence?.languageDiffers).toBe(true);
    expect(evidence?.workTypeDiffers).toBe(true);
    expect(evidence?.editionMarkerDifferences).toEqual([]);
  });

  it("surfaces an edition keyword present on only one side (candidate-only)", () => {
    const base = "x".repeat(60);
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ titleKey: `${base}revised` })
    ]);
    expect(result.candidates[0]?.matchTier).toBe("same_author_fuzzy");
    expect(result.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["revised"]);
  });

  it("surfaces an edition keyword present on only the proposal side (proposal-only)", () => {
    const base = "x".repeat(60);
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: `${base}revised` }), [
      candidate({ titleKey: base })
    ]);
    expect(result.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["revised"]);
  });

  it("reports no difference when both sides carry the same edition marker", () => {
    const base = `${"x".repeat(60)}revised`;
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ titleKey: base })
    ]);
    expect(result.candidates[0]?.matchTier).toBe("exact");
    expect(result.candidates[0]?.evidence.editionMarkerDifferences).toEqual([]);
  });

  it("recognizes an ordinal edition marker", () => {
    const base = "x".repeat(80);
    const result = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ titleKey: `${base}2ndedition` })
    ]);
    expect(result.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["edition:2"]);
  });

  it("distinguishes unabridged from abridged rather than reporting both", () => {
    const base = "x".repeat(80);
    const unabridged = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ titleKey: `${base}unabridged` })
    ]);
    expect(unabridged.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["unabridged"]);

    const abridged = selectWorkDuplicateCandidates(proposal({ titleKey: base }), [
      candidate({ titleKey: `${base}abridged` })
    ]);
    expect(abridged.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["abridged"]);
  });
});
