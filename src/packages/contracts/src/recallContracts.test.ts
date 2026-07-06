import { describe, expect, it } from "vitest";

import {
  parseEnrollRecallItemRequest,
  parseRecallItemDto,
  parseRecallItemListDto,
  parseRecordRecallReviewRequest,
  recallKinds
} from "./recallContracts.js";

describe("enrollRecallItemRequest", () => {
  it("accepts a minimal item (kind + text) without gloss or provenance", () => {
    expect(parseEnrollRecallItemRequest({ kind: "idiom", text: "spill the beans" })).toEqual({
      kind: "idiom",
      text: "spill the beans"
    });
  });

  it("accepts an item with a gloss and provenance link", () => {
    const request = {
      gloss: "to reveal a secret",
      kind: "idiom",
      provenanceEntryId: "note-1",
      text: "spill the beans"
    };
    expect(parseEnrollRecallItemRequest(request)).toEqual(request);
  });

  it("accepts an item linked to a practice chunk", () => {
    const request = { chunkId: "kitchen.meal_planning.whats_for_dinner", kind: "chunk", text: "x" };
    expect(parseEnrollRecallItemRequest(request)).toEqual(request);
  });

  it("rejects a blank chunk id", () => {
    expect(() =>
      parseEnrollRecallItemRequest({ chunkId: "  ", kind: "chunk", text: "x" })
    ).toThrow();
  });

  it.each(recallKinds)("accepts every kind (%s)", (kind) => {
    expect(parseEnrollRecallItemRequest({ kind, text: "x" }).kind).toBe(kind);
  });

  it("accepts an item with production-style Make Durable metadata", () => {
    const request = {
      category: "work" as const,
      cue: "a service is back after a restart",
      kind: "phrase" as const,
      provenanceEntryId: "timeline-1",
      tags: ["service-status"],
      text: "WorkInsight is back up now",
      useContext: "reporting service availability"
    };
    expect(parseEnrollRecallItemRequest(request)).toEqual(request);
  });

  it("rejects a client-supplied sourceProposalCandidateId (set only by the save boundary)", () => {
    expect(() =>
      parseEnrollRecallItemRequest({
        kind: "phrase",
        sourceProposalCandidateId: "cand-1",
        text: "x"
      })
    ).toThrow();
  });

  it("rejects a blank cue and a blank tag", () => {
    expect(() => parseEnrollRecallItemRequest({ cue: "  ", kind: "phrase", text: "x" })).toThrow();
    expect(() =>
      parseEnrollRecallItemRequest({ kind: "phrase", tags: [" "], text: "x" })
    ).toThrow();
  });

  it("rejects an unknown category", () => {
    expect(() =>
      parseEnrollRecallItemRequest({ category: "sports", kind: "phrase", text: "x" })
    ).toThrow();
  });

  it("rejects a blank text", () => {
    expect(() => parseEnrollRecallItemRequest({ kind: "word", text: "   " })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => parseEnrollRecallItemRequest({ kind: "sentence", text: "x" })).toThrow();
  });

  it("rejects unknown fields (no user id or review state from the client)", () => {
    expect(() => parseEnrollRecallItemRequest({ kind: "word", text: "x", userId: "u" })).toThrow();
  });
});

describe("recordRecallReviewRequest", () => {
  it("accepts a grade in range", () => {
    expect(parseRecordRecallReviewRequest({ grade: 4 })).toEqual({ grade: 4 });
  });

  it.each([-1, 6, 2.5])("rejects an out-of-range or non-integer grade %s", (grade) => {
    expect(() => parseRecordRecallReviewRequest({ grade })).toThrow();
  });
});

describe("recall DTOs", () => {
  const review = {
    dueAt: "2026-01-02T00:00:00.000Z",
    easeFactor: 2.5,
    intervalDays: 1,
    lapses: 0,
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    repetitions: 1
  };
  const item = {
    chunkId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "recall-1",
    kind: "phrase" as const,
    provenanceEntryId: null,
    review,
    text: "by and large",
    cue: null,
    useContext: null,
    category: null,
    tags: null,
    sourceProposalCandidateId: null
  };

  it("round-trips a recall item DTO", () => {
    expect(parseRecallItemDto(item)).toEqual(item);
  });

  it("round-trips a production recall item DTO carrying Make Durable metadata", () => {
    const durable = {
      ...item,
      category: "work" as const,
      cue: "a service is back",
      sourceProposalCandidateId: "cand-1",
      tags: ["service-status"],
      useContext: "reporting availability"
    };
    expect(parseRecallItemDto(durable)).toEqual(durable);
  });

  it("round-trips a recall item list DTO", () => {
    expect(parseRecallItemListDto({ items: [item] })).toEqual({ items: [item] });
  });

  it("rejects a DTO missing the review state", () => {
    const { review: _omitted, ...withoutReview } = item;
    expect(() => parseRecallItemDto(withoutReview)).toThrow();
  });
});
