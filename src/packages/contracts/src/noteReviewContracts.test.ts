import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  authorNoteCardRequestSchema,
  noteGradingTargetSchema,
  noteRevealDtoSchema,
  noteReviewNextDtoSchema,
  noteReviewSummaryDtoSchema,
  parseAuthorNoteCardRequest,
  parseEditNotePromptQuestionRequest,
  parseCreateDirectCardRequest,
  parseDirectCardResultDto,
  parseDirectCardSaveResultDto,
  parseExactMaterialQueryRequest,
  parseExactMaterialQueryResponse,
  parseKeepSeparateMaterialRequest,
  parseUseExistingMaterialRequest,
  parseNotePromptSettingsDto,
  parseNotePromptSettingsListDto,
  parseNoteReviewNextDto,
  parseNoteReviewPromptDto,
  parseNoteReviewRatingRequest,
  parseNoteReviewRatingResultDto,
  parseNoteReviewSummaryDto,
  parseNoteRevealDto,
  parseReviewHistoryPageDto,
  parseSetNoteGradingTargetRequest,
  setNoteGradingTargetRequestSchema
} from "./noteReviewContracts.js";

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

const cueDoc = createTextDocument("What is the capital of France?");

describe("noteReviewPromptDtoSchema", () => {
  it("parses a question-phase prompt with its reveal discriminant and card state", () => {
    const parsed = parseNoteReviewPromptDto({
      promptId: "prompt-1",
      noteId: "note-1",
      cueDoc,
      cueText: "What is the capital of France?",
      revealKind: "current_note",
      review
    });
    expect(parsed.revealKind).toBe("current_note");
    expect(parsed.review.state).toBe("new");
  });

  it("rejects a prompt that leaks an answer field", () => {
    expect(() =>
      parseNoteReviewPromptDto({
        promptId: "prompt-1",
        noteId: "note-1",
        cueDoc,
        cueText: "q",
        revealKind: "legacy_custom",
        review,
        answerText: "leaked"
      })
    ).toThrow();
  });

  it("rejects an unknown reveal kind", () => {
    expect(() =>
      parseNoteReviewPromptDto({
        promptId: "prompt-1",
        noteId: "note-1",
        cueDoc,
        cueText: "q",
        revealKind: "guessed",
        review
      })
    ).toThrow();
  });

  it("rejects a malformed cue document", () => {
    expect(() =>
      parseNoteReviewPromptDto({
        promptId: "prompt-1",
        noteId: "note-1",
        cueDoc: { not: "a document" },
        cueText: "q",
        revealKind: "legacy_custom",
        review
      })
    ).toThrow();
  });
});

describe("noteReviewNextDtoSchema", () => {
  it("accepts a null prompt as the due-complete state", () => {
    expect(parseNoteReviewNextDto({ prompt: null })).toEqual({ prompt: null });
  });

  it("accepts the earliest-due prompt", () => {
    const parsed = parseNoteReviewNextDto({
      prompt: {
        promptId: "prompt-1",
        noteId: "note-1",
        cueDoc,
        cueText: "q",
        revealKind: "legacy_custom",
        review
      }
    });
    expect(parsed.prompt?.promptId).toBe("prompt-1");
  });

  it("rejects a missing prompt field", () => {
    expect(() => noteReviewNextDtoSchema.parse({})).toThrow();
  });
});

describe("noteRevealDtoSchema", () => {
  it("parses a current-note reveal (live note body)", () => {
    const bodyDoc = createTextDocument("Paris");
    const parsed = parseNoteRevealDto({ kind: "current_note", bodyDoc, bodyText: "Paris" });
    expect(parsed).toEqual({ kind: "current_note", bodyDoc, bodyText: "Paris" });
  });

  it("parses a legacy-custom reveal (preserved answer)", () => {
    const answerDoc = createTextDocument("Paris, the capital.");
    const parsed = parseNoteRevealDto({
      kind: "legacy_custom",
      answerDoc,
      answerText: "Paris, the capital."
    });
    expect(parsed).toEqual({ kind: "legacy_custom", answerDoc, answerText: "Paris, the capital." });
  });

  it("rejects mixing the two reveal shapes", () => {
    expect(() =>
      noteRevealDtoSchema.parse({
        kind: "current_note",
        answerDoc: createTextDocument("Paris"),
        answerText: "Paris"
      })
    ).toThrow();
  });

  it("parses an expected_response reveal carrying a separate Success check and Reference", () => {
    const successCheckDoc = createTextDocument("Names the two rules.");
    const referenceDoc = createTextDocument("The full note body.");
    const parsed = parseNoteRevealDto({
      kind: "expected_response",
      successCheckDoc,
      successCheckText: "Names the two rules.",
      referenceDoc,
      referenceText: "The full note body."
    });
    expect(parsed).toEqual({
      kind: "expected_response",
      successCheckDoc,
      successCheckText: "Names the two rules.",
      referenceDoc,
      referenceText: "The full note body."
    });
  });

  it("rejects an expected_response reveal that conflates the answer under the storage name", () => {
    expect(() =>
      noteRevealDtoSchema.parse({
        kind: "expected_response",
        answerDoc: createTextDocument("x"),
        answerText: "x"
      })
    ).toThrow();
  });

  it("rejects an expected_response reveal missing its Reference", () => {
    expect(() =>
      noteRevealDtoSchema.parse({
        kind: "expected_response",
        successCheckDoc: createTextDocument("Names the two rules."),
        successCheckText: "Names the two rules."
      })
    ).toThrow();
  });

  it("rejects an unknown reveal kind", () => {
    expect(() => parseNoteRevealDto({ kind: "invented", bodyText: "x" })).toThrow();
  });
});

describe("note-review rating contracts", () => {
  it("parses a valid rating request", () => {
    expect(parseNoteReviewRatingRequest({ rating: "good" })).toEqual({ rating: "good" });
  });

  it("rejects an unknown rating", () => {
    expect(() => parseNoteReviewRatingRequest({ rating: "brilliant" })).toThrow();
  });

  it("parses the rating result carrying the next scheduled state and remaining-due count", () => {
    expect(parseNoteReviewRatingResultDto({ review, remainingDue: 2 })).toEqual({
      review,
      remainingDue: 2
    });
  });

  it("rejects a rating result missing the review", () => {
    expect(() => parseNoteReviewRatingResultDto({ remainingDue: 0 })).toThrow();
  });

  it("rejects a rating result missing the remaining-due count", () => {
    expect(() => parseNoteReviewRatingResultDto({ review })).toThrow();
  });

  it("rejects a negative remaining-due count", () => {
    expect(() => parseNoteReviewRatingResultDto({ review, remainingDue: -1 })).toThrow();
  });
});

describe("noteReviewSummaryDtoSchema", () => {
  it("parses each rolled-up summary status, with due carrying a positive count", () => {
    expect(parseNoteReviewSummaryDto({ status: "not_enrolled" })).toEqual({
      status: "not_enrolled"
    });
    expect(parseNoteReviewSummaryDto({ status: "due", dueCount: 3 })).toEqual({
      status: "due",
      dueCount: 3
    });
    expect(parseNoteReviewSummaryDto({ status: "paused" })).toEqual({ status: "paused" });
    expect(
      parseNoteReviewSummaryDto({ status: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" })
    ).toEqual({ status: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" });
  });

  it("requires a positive due count and a valid scheduled date", () => {
    expect(() => parseNoteReviewSummaryDto({ status: "due" })).toThrow();
    expect(() => parseNoteReviewSummaryDto({ status: "due", dueCount: 0 })).toThrow();
    expect(() =>
      parseNoteReviewSummaryDto({ status: "scheduled", nextReviewAt: "soon" })
    ).toThrow();
  });

  it("rejects a count on a non-due status and an unknown status", () => {
    expect(noteReviewSummaryDtoSchema.safeParse({ status: "paused", dueCount: 1 }).success).toBe(
      false
    );
    expect(() => parseNoteReviewSummaryDto({ status: "archived" })).toThrow();
  });
});

describe("authorNoteCardRequestSchema (#687)", () => {
  const questionDoc = createTextDocument("What is a WAL?");
  const successCheckDoc = createTextDocument("Names durability + ordering");

  it("parses a current-note first-card request over an existing owned note", () => {
    const parsed = parseAuthorNoteCardRequest({
      submissionId: "sub-1",
      noteEntryId: "note-1",
      questionDoc,
      target: { kind: "current_note" }
    });
    expect(parsed.submissionId).toBe("sub-1");
    expect(parsed.noteEntryId).toBe("note-1");
    expect(parsed.target.kind).toBe("current_note");
  });

  it("parses an expected-response request carrying the Success check, and never an answer", () => {
    const parsed = parseAuthorNoteCardRequest({
      submissionId: "sub-2",
      noteEntryId: "note-2",
      questionDoc,
      target: { kind: "expected_response", successCheckDoc }
    });
    expect(parsed.target).toEqual({ kind: "expected_response", successCheckDoc });
    // There is no answer document — the existing note is the reviewed material.
    expect("answerDoc" in parsed).toBe(false);
  });

  it("rejects a blank submission id, a blank note id, a malformed question, and extra keys", () => {
    expect(() =>
      parseAuthorNoteCardRequest({
        submissionId: "  ",
        noteEntryId: "note-1",
        questionDoc,
        target: { kind: "current_note" }
      })
    ).toThrow();
    expect(() =>
      parseAuthorNoteCardRequest({
        submissionId: "sub-3",
        noteEntryId: "  ",
        questionDoc,
        target: { kind: "current_note" }
      })
    ).toThrow();
    expect(() =>
      parseAuthorNoteCardRequest({
        submissionId: "sub-4",
        noteEntryId: "note-1",
        questionDoc: { not: "a document" },
        target: { kind: "current_note" }
      })
    ).toThrow();
    expect(
      authorNoteCardRequestSchema.safeParse({
        submissionId: "sub-5",
        noteEntryId: "note-1",
        questionDoc,
        target: { kind: "current_note" },
        answerDoc: questionDoc
      }).success
    ).toBe(false);
  });
});

describe("note Review settings & history contracts (#660)", () => {
  const questionDoc = createTextDocument("What is a WAL?");
  const answerDoc = createTextDocument("a write-ahead log");
  const successCheckDoc = createTextDocument("Names durability + ordering");

  it("parses a settings list carrying every reveal policy and every card state", () => {
    const parsed = parseNotePromptSettingsListDto({
      prompts: [
        {
          promptId: "p1",
          revision: 0,
          questionDoc,
          questionText: "What is a WAL?",
          reveal: { kind: "current_note" },
          cardState: { state: "due" }
        },
        {
          promptId: "p2",
          revision: 1,
          questionDoc,
          questionText: "What is a WAL?",
          reveal: { kind: "legacy_custom", answerDoc, answerText: "a write-ahead log" },
          cardState: { state: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" }
        },
        {
          promptId: "p3",
          revision: 2,
          questionDoc,
          questionText: "What is a WAL?",
          reveal: { kind: "current_note" },
          cardState: { state: "paused" }
        },
        {
          promptId: "p4",
          revision: 3,
          questionDoc,
          questionText: "What is a WAL?",
          reveal: { kind: "current_note" },
          cardState: { state: "not_in_review" }
        },
        {
          promptId: "p5",
          revision: 4,
          questionDoc,
          questionText: "What is a WAL?",
          reveal: {
            kind: "expected_response",
            successCheckDoc,
            successCheckText: "Names durability + ordering"
          },
          cardState: { state: "due" }
        }
      ]
    });
    expect(parsed.prompts).toHaveLength(5);
    expect(parsed.prompts[1]?.reveal).toEqual({
      kind: "legacy_custom",
      answerDoc,
      answerText: "a write-ahead log"
    });
    expect(parsed.prompts[4]?.reveal).toEqual({
      kind: "expected_response",
      successCheckDoc,
      successCheckText: "Names durability + ordering"
    });
  });

  it("rejects an expected_response policy that leaks the live Reference into the row", () => {
    expect(() =>
      parseNotePromptSettingsDto({
        promptId: "p1",
        revision: 0,
        questionDoc,
        questionText: "q",
        reveal: {
          kind: "expected_response",
          successCheckDoc,
          successCheckText: "Names durability + ordering",
          referenceDoc: answerDoc,
          referenceText: "a write-ahead log"
        },
        cardState: { state: "due" }
      })
    ).toThrow();
  });

  it("rejects a current_note reveal that leaks an answer and a scheduled state without a date", () => {
    expect(() =>
      parseNotePromptSettingsDto({
        promptId: "p1",
        revision: 0,
        questionDoc,
        questionText: "q",
        reveal: { kind: "current_note", answerText: "leaked" },
        cardState: { state: "due" }
      })
    ).toThrow();
    expect(() =>
      parseNotePromptSettingsDto({
        promptId: "p1",
        revision: 0,
        questionDoc,
        questionText: "q",
        reveal: { kind: "current_note" },
        cardState: { state: "scheduled" }
      })
    ).toThrow();
  });

  it("parses a history page with rating and reset events and an opaque cursor, null at the end", () => {
    const parsed = parseReviewHistoryPageDto({
      events: [
        { id: "e1", kind: "rating", rating: "good", occurredAt: "2026-07-01T09:30:00.000Z" },
        { id: "e2", kind: "reset", occurredAt: "2026-06-30T09:30:00.000Z" }
      ],
      nextCursor: "opaque-cursor"
    });
    expect(parsed.nextCursor).toBe("opaque-cursor");
    expect(parseReviewHistoryPageDto({ events: [], nextCursor: null }).events).toEqual([]);
  });

  it("rejects an unknown history kind and a rating event missing its rating", () => {
    expect(() =>
      parseReviewHistoryPageDto({
        events: [{ id: "e1", kind: "paused", occurredAt: "2026-07-01T09:30:00.000Z" }],
        nextCursor: null
      })
    ).toThrow();
    expect(() =>
      parseReviewHistoryPageDto({
        events: [{ id: "e1", kind: "rating", occurredAt: "2026-07-01T09:30:00.000Z" }],
        nextCursor: null
      })
    ).toThrow();
  });

  it("parses a rich question document and rejects a malformed one and extra keys (#687)", () => {
    const questionDoc = createTextDocument("Define a WAL");
    expect(parseEditNotePromptQuestionRequest({ expectedRevision: 2, questionDoc })).toEqual({
      expectedRevision: 2,
      questionDoc
    });
    expect(() =>
      parseEditNotePromptQuestionRequest({
        expectedRevision: 2,
        questionDoc: { not: "a document" }
      })
    ).toThrow();
    expect(() =>
      parseEditNotePromptQuestionRequest({
        expectedRevision: 2,
        question: "Define a WAL"
      })
    ).toThrow();
    expect(() =>
      parseEditNotePromptQuestionRequest({ expectedRevision: -1, questionDoc })
    ).toThrow();
  });
});

describe("setNoteGradingTargetRequestSchema (#686)", () => {
  const successCheckDoc = createTextDocument("Names durability + ordering");

  it("parses a current_note target under keep and restart", () => {
    expect(
      parseSetNoteGradingTargetRequest({
        expectedRevision: 2,
        mode: "keep",
        target: { kind: "current_note" }
      })
    ).toEqual({ expectedRevision: 2, mode: "keep", target: { kind: "current_note" } });
    expect(
      parseSetNoteGradingTargetRequest({
        expectedRevision: 3,
        mode: "restart",
        target: { kind: "current_note" }
      })
    ).toEqual({ expectedRevision: 3, mode: "restart", target: { kind: "current_note" } });
  });

  it("parses an expected_response target carrying only the Success check document", () => {
    expect(
      parseSetNoteGradingTargetRequest({
        expectedRevision: 4,
        mode: "keep",
        target: { kind: "expected_response", successCheckDoc }
      })
    ).toEqual({
      expectedRevision: 4,
      mode: "keep",
      target: { kind: "expected_response", successCheckDoc }
    });
  });

  it("rejects an unknown mode, an unknown target kind, and extra keys", () => {
    expect(
      setNoteGradingTargetRequestSchema.safeParse({
        expectedRevision: 0,
        mode: "reschedule",
        target: { kind: "current_note" }
      }).success
    ).toBe(false);
    expect(() =>
      parseSetNoteGradingTargetRequest({
        expectedRevision: 0,
        mode: "keep",
        target: { kind: "invented" }
      })
    ).toThrow();
    expect(
      setNoteGradingTargetRequestSchema.safeParse({
        expectedRevision: 0,
        mode: "keep",
        target: { kind: "current_note" },
        extra: true
      }).success
    ).toBe(false);
  });

  it("rejects a current_note target that smuggles a Success check, and an expected_response missing it", () => {
    expect(
      noteGradingTargetSchema.safeParse({ kind: "current_note", successCheckDoc }).success
    ).toBe(false);
    expect(() =>
      parseSetNoteGradingTargetRequest({
        expectedRevision: 0,
        mode: "keep",
        target: { kind: "expected_response" }
      })
    ).toThrow();
    expect(() =>
      parseSetNoteGradingTargetRequest({
        expectedRevision: 0,
        mode: "keep",
        target: { kind: "expected_response", successCheckDoc: { not: "a document" } }
      })
    ).toThrow();
    expect(() =>
      parseSetNoteGradingTargetRequest({
        expectedRevision: -1,
        mode: "keep",
        target: { kind: "current_note" }
      })
    ).toThrow();
  });
});

describe("direct card contracts (#689)", () => {
  const questionDoc = createTextDocument("Which sorting algorithm is stable?");
  const answerDoc = createTextDocument("Merge sort is stable.");
  const successCheckDoc = createTextDocument("Names merge sort.");

  it("parses a current-note direct card request", () => {
    const parsed = parseCreateDirectCardRequest({
      submissionId: "sub-1",
      questionDoc,
      answerDoc,
      target: { kind: "current_note" }
    });
    expect(parsed.submissionId).toBe("sub-1");
    expect(parsed.target.kind).toBe("current_note");
  });

  it("parses an expected-response direct card request", () => {
    const parsed = parseCreateDirectCardRequest({
      submissionId: "sub-2",
      questionDoc,
      answerDoc,
      target: { kind: "expected_response", successCheckDoc }
    });
    expect(parsed.target).toEqual({ kind: "expected_response", successCheckDoc });
  });

  it("rejects a blank submission id or a malformed document", () => {
    expect(() =>
      parseCreateDirectCardRequest({
        submissionId: "  ",
        questionDoc,
        answerDoc,
        target: { kind: "current_note" }
      })
    ).toThrow();
    expect(() =>
      parseCreateDirectCardRequest({
        submissionId: "sub-3",
        questionDoc: { not: "a document" },
        answerDoc,
        target: { kind: "current_note" }
      })
    ).toThrow();
  });

  it("parses a direct card result dto", () => {
    const parsed = parseDirectCardResultDto({ noteId: "n1", promptId: "p1", review });
    expect(parsed).toEqual({ noteId: "n1", promptId: "p1", review });
  });
});

describe("material review contracts (#712)", () => {
  const questionDoc = createTextDocument("Which sorting algorithm is stable?");
  const answerDoc = createTextDocument("Merge sort is stable.");
  const candidate = {
    answerExcerpt: "Merge sort is stable.",
    cardCount: 2,
    noteId: "note-1",
    sourceContext: "chapter 3" as string | null
  };
  const draft = {
    submissionId: "sub-1",
    attemptId: "attempt-1",
    revision: 0,
    questionDoc,
    answerDoc,
    target: { kind: "current_note" as const }
  };

  it("parses a needs_material_review save result and rejects an unknown status", () => {
    const parsed = parseDirectCardSaveResultDto({
      status: "needs_material_review",
      review: {
        attemptId: "attempt-1",
        candidateFingerprint: "fp",
        candidates: [candidate],
        revision: 3
      }
    });
    if (parsed.status !== "needs_material_review") {
      throw new Error("expected needs_material_review");
    }
    expect(parsed.review.candidates[0]!.cardCount).toBe(2);
    expect(() => parseDirectCardSaveResultDto({ status: "duplicate", review: {} })).toThrow();
  });

  it("parses created and reused save results carrying the shared direct-card payload", () => {
    const created = parseDirectCardSaveResultDto({
      status: "created",
      result: { noteId: "n1", promptId: "p1", review }
    });
    const reused = parseDirectCardSaveResultDto({
      status: "reused",
      result: { noteId: "n1", promptId: "p2", review }
    });
    expect(created.status).toBe("created");
    expect(reused.status).toBe("reused");
  });

  it("rejects extra keys on a candidate and on the review dto", () => {
    expect(() =>
      parseDirectCardSaveResultDto({
        status: "needs_material_review",
        review: {
          attemptId: "attempt-1",
          candidateFingerprint: "fp",
          candidates: [{ ...candidate, verdict: "duplicate" }],
          revision: 0
        }
      })
    ).toThrow();
    expect(() =>
      parseDirectCardSaveResultDto({
        status: "needs_material_review",
        review: {
          attemptId: "attempt-1",
          candidateFingerprint: "fp",
          candidates: [],
          revision: 0,
          extra: true
        }
      })
    ).toThrow();
  });

  it("parses a null source context and rejects a negative card count", () => {
    const parsed = parseDirectCardSaveResultDto({
      status: "needs_material_review",
      review: {
        attemptId: "attempt-1",
        candidateFingerprint: "fp",
        candidates: [{ answerExcerpt: "x", cardCount: 0, noteId: "n", sourceContext: null }],
        revision: 0
      }
    });
    if (parsed.status !== "needs_material_review") {
      throw new Error("expected needs_material_review");
    }
    expect(parsed.review.candidates[0]!.sourceContext).toBeNull();
    expect(() =>
      parseDirectCardSaveResultDto({
        status: "needs_material_review",
        review: {
          attemptId: "attempt-1",
          candidateFingerprint: "fp",
          candidates: [{ answerExcerpt: "x", cardCount: -1, noteId: "n", sourceContext: null }],
          revision: 0
        }
      })
    ).toThrow();
  });

  it("round-trips the advisory exact-material query request and response", () => {
    expect(parseExactMaterialQueryRequest({ answerDoc }).answerDoc).toEqual(answerDoc);
    const response = parseExactMaterialQueryResponse({ candidates: [candidate] });
    expect(response.candidates).toHaveLength(1);
    expect(() => parseExactMaterialQueryRequest({ answerDoc, extra: 1 })).toThrow();
    expect(() => parseExactMaterialQueryResponse({ candidates: "nope" })).toThrow();
  });

  it("parses a use-existing decision and rejects a blank chosen note", () => {
    const parsed = parseUseExistingMaterialRequest({ ...draft, noteEntryId: "note-1" });
    expect(parsed.noteEntryId).toBe("note-1");
    expect(() => parseUseExistingMaterialRequest({ ...draft, noteEntryId: "  " })).toThrow();
    expect(() => parseUseExistingMaterialRequest(draft)).toThrow();
  });

  it("parses a keep-separate decision and rejects a negative revision or extra key", () => {
    const parsed = parseKeepSeparateMaterialRequest(draft);
    expect(parsed.attemptId).toBe("attempt-1");
    expect(() => parseKeepSeparateMaterialRequest({ ...draft, revision: -1 })).toThrow();
    expect(() => parseKeepSeparateMaterialRequest({ ...draft, noteEntryId: "note-1" })).toThrow();
  });
});
