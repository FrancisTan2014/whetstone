import { describe, expect, it } from "vitest";

import {
  parseProposedWorkMetadataDto,
  parseWorkCreationAttemptDto,
  reviewedCandidateSnapshotSchema,
  workCreationStageDtoSchema
} from "./workCreationContracts.js";

const proposed = {
  authorId: "author-1",
  authorName: "Martin Kleppmann",
  language: "en",
  title: "Designing Data-Intensive Applications",
  workType: "book"
} as const;

const attemptDto = {
  attemptId: "attempt-1",
  candidateFingerprint: null,
  candidates: [],
  createdAt: "2026-02-01T00:00:00.000Z",
  expiresAt: "2026-02-01T01:00:00.000Z",
  proposed,
  revision: 0,
  sourceHash: null,
  sourceKind: "markdown",
  stage: { bound: true },
  state: "pending",
  updatedAt: "2026-02-01T00:00:00.000Z"
} as const;

describe("proposedWorkMetadataSchema", () => {
  it("accepts a valid proposal and defaults a missing authorId to null", () => {
    const parsed = parseProposedWorkMetadataDto({
      authorName: "New Author",
      language: "en",
      title: "A Title",
      workType: "book"
    });
    expect(parsed.authorId).toBeNull();
  });

  it("rejects empty required strings and unknown vocabularies", () => {
    expect(() => parseProposedWorkMetadataDto({ ...proposed, title: "" })).toThrow();
    expect(() => parseProposedWorkMetadataDto({ ...proposed, authorName: "" })).toThrow();
    expect(() => parseProposedWorkMetadataDto({ ...proposed, language: "fr" })).toThrow();
    expect(() => parseProposedWorkMetadataDto({ ...proposed, workType: "novel" })).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      parseProposedWorkMetadataDto({ ...proposed, extra: "nope" })
    ).toThrow();
  });
});

describe("workCreationAttemptDtoSchema", () => {
  it("parses a well-formed attempt view", () => {
    expect(parseWorkCreationAttemptDto(attemptDto)).toEqual(attemptDto);
  });

  it("accepts a 64-hex sourceHash and rejects a malformed one", () => {
    expect(
      parseWorkCreationAttemptDto({ ...attemptDto, sourceHash: "a".repeat(64) }).sourceHash
    ).toBe("a".repeat(64));
    expect(() =>
      parseWorkCreationAttemptDto({ ...attemptDto, sourceHash: "not-hex" })
    ).toThrow();
    expect(() =>
      parseWorkCreationAttemptDto({ ...attemptDto, sourceHash: "A".repeat(64) })
    ).toThrow();
  });

  it("rejects a negative or non-integer revision", () => {
    expect(() => parseWorkCreationAttemptDto({ ...attemptDto, revision: -1 })).toThrow();
    expect(() => parseWorkCreationAttemptDto({ ...attemptDto, revision: 1.5 })).toThrow();
  });

  it("exposes the stage only as presence, never a filesystem path", () => {
    expect(() => workCreationStageDtoSchema.parse({ bound: true, path: "/srv/x" })).toThrow();
    expect(() => parseWorkCreationAttemptDto({ ...attemptDto, stage: { path: "/srv/x" } })).toThrow();
  });

  it("rejects extra top-level fields", () => {
    expect(() => parseWorkCreationAttemptDto({ ...attemptDto, stagePath: "/srv/x" })).toThrow();
  });
});

describe("reviewedCandidateSnapshotSchema", () => {
  it("requires every candidate field and forbids extras", () => {
    const candidate = {
      authorId: "author-1",
      authorName: "Martin Kleppmann",
      entryId: "work-1",
      language: "en",
      title: "Designing Data-Intensive Applications",
      workType: "book"
    };
    expect(reviewedCandidateSnapshotSchema.parse([candidate])).toEqual([candidate]);
    expect(() => reviewedCandidateSnapshotSchema.parse([{ ...candidate, score: 0.9 }])).toThrow();
    const { entryId: _omit, ...missing } = candidate;
    expect(() => reviewedCandidateSnapshotSchema.parse([missing])).toThrow();
  });
});
