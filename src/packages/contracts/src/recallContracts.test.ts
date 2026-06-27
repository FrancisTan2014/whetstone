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

  it.each(recallKinds)("accepts every kind (%s)", (kind) => {
    expect(parseEnrollRecallItemRequest({ kind, text: "x" }).kind).toBe(kind);
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
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "recall-1",
    kind: "phrase" as const,
    provenanceEntryId: null,
    review,
    text: "by and large"
  };

  it("round-trips a recall item DTO", () => {
    expect(parseRecallItemDto(item)).toEqual(item);
  });

  it("round-trips a recall item list DTO", () => {
    expect(parseRecallItemListDto({ items: [item] })).toEqual({ items: [item] });
  });

  it("rejects a DTO missing the review state", () => {
    const { review: _omitted, ...withoutReview } = item;
    expect(() => parseRecallItemDto(withoutReview)).toThrow();
  });
});
