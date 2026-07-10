import { describe, expect, it } from "vitest";

import {
  depositRecallItemToolInputSchema,
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

describe("depositRecallItemToolInput (#458)", () => {
  const valid = {
    kind: "phrase" as const,
    target: "it depends on",
    cue: "expressing a dependency",
    useContext: "explaining what a result hinges on",
    category: "language" as const,
    tags: ["grammar"],
    provenanceEntryId: "entry-1",
    gloss: "use 'on' after 'depends'"
  };

  it("accepts a full production-style deposit", () => {
    expect(depositRecallItemToolInputSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a deposit without the optional tags/gloss/provenance", () => {
    const minimal = {
      kind: "word" as const,
      target: "ubiquitous",
      cue: "everywhere at once",
      useContext: "describing something common",
      category: "language" as const
    };
    expect(depositRecallItemToolInputSchema.parse(minimal)).toEqual(minimal);
  });

  it.each(["target", "cue", "useContext"])("rejects a blank %s", (field) => {
    expect(() => depositRecallItemToolInputSchema.parse({ ...valid, [field]: "   " })).toThrow();
  });

  it.each(["kind", "target", "cue", "useContext", "category"])(
    "rejects input missing the required field %s",
    (field) => {
      const { [field]: _omitted, ...rest } = valid;
      expect(() => depositRecallItemToolInputSchema.parse(rest)).toThrow();
    }
  );

  it("rejects an unknown category or kind", () => {
    expect(() =>
      depositRecallItemToolInputSchema.parse({ ...valid, category: "sports" })
    ).toThrow();
    expect(() => depositRecallItemToolInputSchema.parse({ ...valid, kind: "sentence" })).toThrow();
  });

  it("rejects integrity-bearing or unknown fields (text/sourceProposalCandidateId/chunkId)", () => {
    expect(() => depositRecallItemToolInputSchema.parse({ ...valid, text: "x" })).toThrow();
    expect(() =>
      depositRecallItemToolInputSchema.parse({ ...valid, sourceProposalCandidateId: "cand-1" })
    ).toThrow();
    expect(() => depositRecallItemToolInputSchema.parse({ ...valid, chunkId: "c-1" })).toThrow();
  });
});

describe("recordRecallReviewRequest", () => {
  it.each(["again", "hard", "good", "easy"] as const)("accepts the %s rating", (rating) => {
    expect(parseRecordRecallReviewRequest({ rating })).toEqual({ rating });
  });

  it.each([0, "perfect", 2.5, null])("rejects a non-rating value %s", (rating) => {
    expect(() => parseRecordRecallReviewRequest({ rating })).toThrow();
  });

  it("rejects a request missing the rating", () => {
    expect(() => parseRecordRecallReviewRequest({})).toThrow();
  });
});

describe("recall DTOs", () => {
  const review = {
    due: "2026-01-02T00:00:00.000Z",
    stability: 2.3,
    difficulty: 5.1,
    elapsedDays: 0,
    scheduledDays: 1,
    learningSteps: 1,
    reps: 1,
    lapses: 0,
    state: "review" as const,
    lastReviewedAt: "2026-01-01T00:00:00.000Z"
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
