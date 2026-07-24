import { describe, expect, it } from "vitest";

import {
  keepSeparateDecisionRequestSchema,
  openExistingDecisionRequestSchema,
  parseKeepSeparateDecisionRequest,
  parseOpenExistingDecisionRequest,
  parseWorkCreationReviewDto,
  workCreationBeginOutcomes,
  workCreationDecisionOutcomes,
  workCreationReviewDtoSchema,
  workDuplicateCandidateReviewDtoSchema
} from "./workCreationReviewContracts.js";

const candidate = {
  author: { id: "author-1", name: "Robert C. Martin" },
  entryId: "work-1",
  evidence: {
    editionMarkerDifferences: ["revised"],
    languageDiffers: false,
    sameAuthor: true,
    titleSimilarity: 0.92,
    workTypeDiffers: false
  },
  language: "en",
  matchTier: "same_author_fuzzy",
  origin: "imported",
  title: "Clean Code",
  workType: "book"
} as const;

const review = {
  attemptId: "attempt-1",
  candidateFingerprint: "fp",
  candidates: [candidate],
  proposed: {
    authorName: "Robert C. Martin",
    language: "en",
    title: "Clean Coder",
    workType: "book"
  },
  revision: 3
} as const;

describe("workDuplicateCandidateReviewDtoSchema", () => {
  it("accepts a factual candidate row with full identity and evidence", () => {
    expect(workDuplicateCandidateReviewDtoSchema.parse(candidate)).toEqual(candidate);
  });

  it("rejects an unknown extra field so a verdict can never smuggle in", () => {
    expect(
      workDuplicateCandidateReviewDtoSchema.safeParse({ ...candidate, isDuplicate: true }).success
    ).toBe(false);
  });

  it("rejects an unknown match tier", () => {
    expect(
      workDuplicateCandidateReviewDtoSchema.safeParse({ ...candidate, matchTier: "guess" }).success
    ).toBe(false);
  });

  it("rejects a blank candidate entry id", () => {
    expect(
      workDuplicateCandidateReviewDtoSchema.safeParse({ ...candidate, entryId: "  " }).success
    ).toBe(false);
  });
});

describe("parseWorkCreationReviewDto", () => {
  it("parses a full review view including its revision fence and fingerprint", () => {
    expect(parseWorkCreationReviewDto(review)).toEqual(review);
  });

  it("accepts an empty candidate list and an empty fingerprint", () => {
    const parsed = parseWorkCreationReviewDto({
      ...review,
      candidateFingerprint: "",
      candidates: []
    });
    expect(parsed.candidates).toEqual([]);
  });

  it("rejects a negative revision", () => {
    expect(workCreationReviewDtoSchema.safeParse({ ...review, revision: -1 }).success).toBe(false);
  });

  it("rejects a proposal carrying an author id (a brand-new author has no identity yet)", () => {
    expect(
      workCreationReviewDtoSchema.safeParse({
        ...review,
        proposed: { ...review.proposed, authorId: "author-1" }
      }).success
    ).toBe(false);
  });
});

describe("parseOpenExistingDecisionRequest", () => {
  it("parses a candidate id plus the revision fence", () => {
    expect(parseOpenExistingDecisionRequest({ entryId: "work-1", revision: 2 })).toEqual({
      entryId: "work-1",
      revision: 2
    });
  });

  it("rejects a missing entry id", () => {
    expect(openExistingDecisionRequestSchema.safeParse({ revision: 2 }).success).toBe(false);
  });

  it("rejects a non-integer revision", () => {
    expect(
      openExistingDecisionRequestSchema.safeParse({ entryId: "work-1", revision: 1.5 }).success
    ).toBe(false);
  });
});

describe("parseKeepSeparateDecisionRequest", () => {
  it("parses the revision fence", () => {
    expect(parseKeepSeparateDecisionRequest({ revision: 4 })).toEqual({ revision: 4 });
  });

  it("rejects an extra field", () => {
    expect(
      keepSeparateDecisionRequestSchema.safeParse({ revision: 4, entryId: "x" }).success
    ).toBe(false);
  });
});

describe("outcome vocabularies", () => {
  it("names every begin outcome", () => {
    expect([...workCreationBeginOutcomes]).toEqual([
      "exact_existing",
      "created",
      "needs_review",
      "empty_content",
      "uncertain"
    ]);
  });

  it("names every decision outcome", () => {
    expect([...workCreationDecisionOutcomes]).toEqual([
      "opened",
      "created",
      "needs_review",
      "exact_existing",
      "existing_gone",
      "expired",
      "superseded",
      "uncertain",
      "not_found"
    ]);
  });
});
