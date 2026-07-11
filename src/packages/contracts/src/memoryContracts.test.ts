import { describe, expect, it } from "vitest";

import {
  depositMemoryRequestSchema,
  getMemoryPromptToolInputSchema,
  listDuePromptsToolInputSchema,
  memoryPromptCardDtoSchema,
  parseDepositMemoryRequest,
  parseMemoryDepositDto,
  parseMemoryPromptCardDto,
  parseMemoryPromptCardListDto,
  parseRecordMemoryReviewRequest,
  recordReviewToolInputSchema,
  searchMemoryToolInputSchema
} from "./memoryContracts.js";

const review = {
  due: "2026-07-11T00:00:00.000Z",
  stability: 1,
  difficulty: 5,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: "new",
  lastReviewedAt: null
} as const;

describe("depositMemoryRequestSchema", () => {
  it("accepts a note with one scheduled prompt", () => {
    const parsed = parseDepositMemoryRequest({
      captureSource: "practice",
      noteText: "遠慮",
      prompts: [{ cueText: "when holding back", answerText: "遠慮", chunkId: "chunk-1" }]
    });
    expect(parsed.prompts).toHaveLength(1);
    expect(parsed.derivedFromEntryId ?? null).toBeNull();
  });

  it("accepts a prompt with a gloss term and no answer (a draft candidate)", () => {
    const parsed = parseDepositMemoryRequest({
      captureSource: "tool",
      noteText: "serendipity",
      derivedFromEntryId: "block-9",
      prompts: [{ cueText: "serendipity", glossTerm: "serendipity" }]
    });
    expect(parsed.prompts[0]?.answerText ?? null).toBeNull();
    expect(parsed.derivedFromEntryId).toBe("block-9");
  });

  it("rejects an empty prompt list", () => {
    expect(() =>
      depositMemoryRequestSchema.parse({
        captureSource: "manual",
        noteText: "x",
        prompts: []
      })
    ).toThrow(/at least one prompt/);
  });

  it("rejects a blank note text and an unknown capture source", () => {
    expect(() =>
      depositMemoryRequestSchema.parse({
        captureSource: "manual",
        noteText: "   ",
        prompts: [{ cueText: "cue", answerText: "a" }]
      })
    ).toThrow(/noteText/);
    expect(() =>
      depositMemoryRequestSchema.parse({
        captureSource: "speech",
        noteText: "x",
        prompts: [{ cueText: "cue", answerText: "a" }]
      })
    ).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      depositMemoryRequestSchema.parse({
        captureSource: "manual",
        noteText: "x",
        prompts: [{ cueText: "cue", answerText: "a" }],
        userId: "user-1"
      })
    ).toThrow();
  });
});

describe("recordMemoryReviewRequestSchema", () => {
  it("accepts a valid rating and rejects an invalid one", () => {
    expect(parseRecordMemoryReviewRequest({ rating: "good" }).rating).toBe("good");
    expect(() => parseRecordMemoryReviewRequest({ rating: "meh" })).toThrow();
  });
});

describe("memoryPromptCardDtoSchema", () => {
  it("round-trips a scheduled card and rejects a null answer", () => {
    const card = {
      promptId: "prompt-1",
      noteId: "note-1",
      cueText: "when holding back",
      answerText: "遠慮",
      chunkId: null,
      review
    };
    expect(memoryPromptCardDtoSchema.parse(card)).toEqual(card);
    expect(() => memoryPromptCardDtoSchema.parse({ ...card, answerText: null })).toThrow();
  });

  it("parses a card list", () => {
    const list = parseMemoryPromptCardListDto({
      items: [
        {
          promptId: "prompt-1",
          noteId: "note-1",
          cueText: "c",
          answerText: "a",
          chunkId: "chunk-1",
          review
        }
      ]
    });
    expect(list.items).toHaveLength(1);
  });

  it("parses a single card via parseMemoryPromptCardDto", () => {
    const card = parseMemoryPromptCardDto({
      promptId: "prompt-1",
      noteId: "note-1",
      cueText: "when holding back",
      answerText: "遠慮",
      chunkId: null,
      review
    });
    expect(card.promptId).toBe("prompt-1");
    expect(card.answerText).toBe("遠慮");
  });
});

describe("memoryDepositDtoSchema", () => {
  it("parses a deposit of a note plus its prompts via parseMemoryDepositDto", () => {
    const deposit = parseMemoryDepositDto({
      note: {
        noteId: "note-1",
        captureSource: "practice",
        bodyText: "遠慮",
        derivedFromEntryId: "block-9"
      },
      prompts: [
        {
          promptId: "prompt-1",
          noteId: "note-1",
          lifecycle: "scheduled",
          cueText: "when holding back",
          answerText: "遠慮",
          chunkId: "chunk-1",
          review
        }
      ]
    });
    expect(deposit.note.noteId).toBe("note-1");
    expect(deposit.prompts).toHaveLength(1);
    expect(deposit.prompts[0]?.lifecycle).toBe("scheduled");
  });
});

describe("MCP tool inputs", () => {
  it("validates list/record/search/get inputs", () => {
    expect(listDuePromptsToolInputSchema.parse({}).limit).toBeUndefined();
    expect(listDuePromptsToolInputSchema.parse({ limit: 5 }).limit).toBe(5);
    expect(() => listDuePromptsToolInputSchema.parse({ limit: 0 })).toThrow();

    expect(recordReviewToolInputSchema.parse({ rating: "easy", promptId: "p1" }).promptId).toBe(
      "p1"
    );
    expect(() => recordReviewToolInputSchema.parse({ rating: "easy", promptId: " " })).toThrow();

    expect(searchMemoryToolInputSchema.parse({ query: "" }).query).toBe("");
    expect(getMemoryPromptToolInputSchema.parse({ promptId: "p1" }).promptId).toBe("p1");
    expect(() => getMemoryPromptToolInputSchema.parse({ promptId: "" })).toThrow();
  });
});
