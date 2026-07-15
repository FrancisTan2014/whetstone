import { describe, expect, it } from "vitest";

import { createTextDocument } from "@whetstone/document";

import {
  depositMemoryRequestSchema,
  enrollNoteRequestSchema,
  getMemoryPromptToolInputSchema,
  importMemoryRequestSchema,
  listDuePromptsToolInputSchema,
  memoryPromptCardDtoSchema,
  memoryPromptDtoSchema,
  parseAddMemoryPromptRequest,
  parseDepositMemoryRequest,
  parseEditMemoryNoteRequest,
  parseEditMemoryPromptRequest,
  parseEnrollNoteRequest,
  parseImportMemoryRequest,
  parseImportMemoryResultDto,
  parseMemoryDepositDto,
  parseMemoryGlossSuggestionDto,
  parseMemoryNoteDetailDto,
  parseMemoryNoteListDto,
  parseMemoryNoteSummaryDto,
  parseMemoryPromptCardDto,
  parseMemoryPromptCardListDto,
  parseNoteReviewDto,
  parseRecordMemoryReviewRequest,
  promptCardStatusSchema,
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

  it("accepts optional rich cue/answer documents on a prompt (#574)", () => {
    const cueDoc = createTextDocument("per");
    const answerDoc = createTextDocument("each");
    const parsed = parseDepositMemoryRequest({
      captureSource: "import",
      noteText: "per",
      prompts: [{ cueText: "per", answerText: "each", cueDoc, answerDoc }]
    });
    expect(parsed.prompts[0]?.cueDoc).toEqual(cueDoc);
    expect(parsed.prompts[0]?.answerDoc).toEqual(answerDoc);
  });

  it("rejects a cue document that is not a valid document node", () => {
    expect(() =>
      depositMemoryRequestSchema.parse({
        captureSource: "import",
        noteText: "per",
        prompts: [{ cueText: "per", cueDoc: { type: "not-a-document" } }]
      })
    ).toThrow(/valid document/);
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
          lifecycle: "ready",
          cueText: "when holding back",
          answerText: "遠慮",
          chunkId: "chunk-1",
          cardStatus: "active",
          review
        }
      ]
    });
    expect(deposit.note.noteId).toBe("note-1");
    expect(deposit.prompts).toHaveLength(1);
    expect(deposit.prompts[0]?.lifecycle).toBe("ready");
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

describe("Memory note list/detail DTOs (#573)", () => {
  const summary = {
    noteId: "note-1",
    captureSource: "manual",
    bodyText: "遠慮 — to hold back",
    promptCount: 3,
    draftCount: 1,
    scheduledCount: 2,
    dueCount: 1,
    nextDueAt: "2026-07-11T00:00:00.000Z"
  } as const;

  it("parses a note summary and rejects a negative count", () => {
    expect(parseMemoryNoteSummaryDto(summary)).toEqual(summary);
    expect(() => parseMemoryNoteSummaryDto({ ...summary, promptCount: -1 })).toThrow();
  });

  it("parses a summary with no scheduled prompt (nextDueAt null)", () => {
    const draftOnly = {
      ...summary,
      scheduledCount: 0,
      dueCount: 0,
      draftCount: 3,
      nextDueAt: null
    };
    expect(parseMemoryNoteSummaryDto(draftOnly).nextDueAt).toBeNull();
  });

  it("parses a note list", () => {
    expect(parseMemoryNoteListDto({ items: [summary] }).items).toHaveLength(1);
  });

  it("parses a note detail (note + prompts)", () => {
    const detail = parseMemoryNoteDetailDto({
      note: {
        noteId: "note-1",
        captureSource: "manual",
        bodyText: "body",
        derivedFromEntryId: null
      },
      prompts: [
        {
          promptId: "p1",
          noteId: "note-1",
          lifecycle: "draft",
          cueText: "cue",
          answerText: null,
          chunkId: null,
          cardStatus: null,
          review: null
        }
      ]
    });
    expect(detail.prompts[0]?.lifecycle).toBe("draft");
  });
});

describe("Memory CRUD requests + gloss suggestion (#573)", () => {
  it("parses an edit-note request and rejects a blank body", () => {
    expect(parseEditMemoryNoteRequest({ noteText: "new body" }).noteText).toBe("new body");
    expect(() => parseEditMemoryNoteRequest({ noteText: "   " })).toThrow();
  });

  it("parses an edit-prompt request, allowing a null answer", () => {
    expect(parseEditMemoryPromptRequest({ cueText: "cue", answerText: "ans" }).answerText).toBe(
      "ans"
    );
    expect(
      parseEditMemoryPromptRequest({ cueText: "cue", answerText: null }).answerText
    ).toBeNull();
    expect(() => parseEditMemoryPromptRequest({ cueText: " ", answerText: "ans" })).toThrow();
  });

  it("parses an add-prompt request (same shape as a deposit prompt)", () => {
    const added = parseAddMemoryPromptRequest({ cueText: "cue", glossTerm: "遠慮" });
    expect(added.cueText).toBe("cue");
    expect(added.glossTerm).toBe("遠慮");
  });

  it("parses a gloss suggestion DTO with and without a suggestion", () => {
    expect(
      parseMemoryGlossSuggestionDto({ term: "遠慮", suggestion: "to hold back" }).suggestion
    ).toBe("to hold back");
    expect(
      parseMemoryGlossSuggestionDto({ term: "xyzzy", suggestion: null }).suggestion
    ).toBeNull();
  });
});

describe("import batch contracts (#574)", () => {
  it("accepts a batch of deposit items and preserves their order", () => {
    const parsed = parseImportMemoryRequest({
      items: [
        { captureSource: "import", noteText: "per", prompts: [{ cueText: "per" }] },
        {
          captureSource: "import",
          noteText: "diem\n\nday",
          prompts: [{ cueText: "diem", answerText: "day" }]
        }
      ]
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]?.prompts[0]?.answerText).toBe("day");
  });

  it("rejects an empty batch", () => {
    expect(() => importMemoryRequestSchema.parse({ items: [] })).toThrow(/at least one item/);
  });

  it("rejects an item that is not a valid deposit request", () => {
    expect(() =>
      importMemoryRequestSchema.parse({
        items: [{ captureSource: "import", noteText: "x", prompts: [] }]
      })
    ).toThrow(/at least one prompt/);
  });

  it("parses an import result of created notes via parseImportMemoryResultDto", () => {
    const result = parseImportMemoryResultDto({
      imported: [
        {
          note: {
            noteId: "note-1",
            captureSource: "import",
            bodyText: "per",
            derivedFromEntryId: null
          },
          prompts: [
            {
              promptId: "prompt-1",
              noteId: "note-1",
              lifecycle: "draft",
              cueText: "per",
              answerText: null,
              chunkId: null,
              cardStatus: null,
              review
            }
          ]
        }
      ]
    });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.prompts[0]?.lifecycle).toBe("draft");
  });
});

describe("deliberate review enrollment contracts (#575)", () => {
  it("parses a cue/reveal enrollment, deriving docs when omitted and keeping them when supplied", () => {
    const plain = parseEnrollNoteRequest({
      cueText: "spill the beans",
      answerText: "to reveal a secret"
    });
    expect(plain.cueText).toBe("spill the beans");
    expect(plain.answerText).toBe("to reveal a secret");
    expect(plain.cueDoc).toBeUndefined();

    const rich = parseEnrollNoteRequest({
      cueText: "spill the beans",
      answerText: "to reveal a secret",
      cueDoc: createTextDocument("spill the beans"),
      answerDoc: createTextDocument("to reveal a secret")
    });
    expect(rich.cueDoc).toEqual(createTextDocument("spill the beans"));
  });

  it("requires both a non-blank cue and a non-blank answer, and rejects extra keys", () => {
    expect(() => enrollNoteRequestSchema.parse({ cueText: "cue" })).toThrow();
    expect(() => enrollNoteRequestSchema.parse({ cueText: "  ", answerText: "a" })).toThrow();
    expect(() => enrollNoteRequestSchema.parse({ cueText: "c", answerText: "  " })).toThrow();
    expect(() =>
      enrollNoteRequestSchema.parse({ cueText: "c", answerText: "a", extra: true })
    ).toThrow();
  });

  it("accepts the two card statuses and rejects anything else", () => {
    expect(promptCardStatusSchema.parse("active")).toBe("active");
    expect(promptCardStatusSchema.parse("paused")).toBe("paused");
    expect(() => promptCardStatusSchema.parse("archived")).toThrow();
  });

  it("requires cardStatus on a prompt DTO (nullable), rejecting a missing field", () => {
    const base = {
      promptId: "p1",
      noteId: "note-1",
      lifecycle: "ready",
      cueText: "cue",
      answerText: "ans",
      chunkId: null,
      review
    } as const;
    expect(memoryPromptDtoSchema.parse({ ...base, cardStatus: "paused" }).cardStatus).toBe(
      "paused"
    );
    expect(memoryPromptDtoSchema.parse({ ...base, cardStatus: null }).cardStatus).toBeNull();
    expect(() => memoryPromptDtoSchema.parse(base)).toThrow();
  });

  it("parses a note-review DTO of a note and its prompts", () => {
    const dto = parseNoteReviewDto({
      noteId: "note-1",
      prompts: [
        {
          promptId: "p1",
          noteId: "note-1",
          lifecycle: "ready",
          cueText: "cue",
          answerText: "ans",
          chunkId: null,
          cardStatus: "active",
          review
        }
      ]
    });
    expect(dto.noteId).toBe("note-1");
    expect(dto.prompts[0]?.cardStatus).toBe("active");
  });
});
