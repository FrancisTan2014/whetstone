import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  noteRevealDtoSchema,
  noteReviewNextDtoSchema,
  parseNoteReviewNextDto,
  parseNoteReviewPromptDto,
  parseNoteReviewRatingRequest,
  parseNoteReviewRatingResultDto,
  parseNoteRevealDto
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
