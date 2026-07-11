import { describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "./entry.js";
import { newReviewState, type ReviewState } from "./fsrs.js";
import {
  buildMemoryPrompt,
  captureSources,
  isCaptureSource,
  isSchedulablePrompt,
  memoryPromptFaces,
  memoryPromptOwner,
  promptLifecycles,
  resolvePromptLifecycle,
  type MemoryNote,
  type MemoryPrompt
} from "./memory.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");

function seed(): ReviewState {
  return newReviewState(NOW);
}

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: toEntryId("note-1"),
    userId: "user-1",
    captureSource: "practice",
    bodyText: "遠慮 — to hold back out of consideration",
    derivedFromEntryId: null,
    ...overrides
  };
}

describe("captureSources", () => {
  it("recognizes every capture source and rejects others", () => {
    expect(captureSources).toEqual(["manual", "reader", "import", "practice", "tool"]);
    for (const source of captureSources) {
      expect(isCaptureSource(source)).toBe(true);
    }
    expect(isCaptureSource("speech")).toBe(false);
    expect(isCaptureSource(undefined)).toBe(false);
  });
});

describe("promptLifecycles", () => {
  it("has exactly draft and scheduled", () => {
    expect(promptLifecycles).toEqual(["draft", "scheduled"]);
  });
});

describe("isSchedulablePrompt / resolvePromptLifecycle", () => {
  it("is scheduled only when both cue and answer are meaningful", () => {
    expect(isSchedulablePrompt("cue", "answer")).toBe(true);
    expect(resolvePromptLifecycle("cue", "answer")).toBe("scheduled");
  });

  it("is draft when the answer is absent (no revealable answer)", () => {
    expect(isSchedulablePrompt("cue", null)).toBe(false);
    expect(resolvePromptLifecycle("cue", null)).toBe("draft");
  });

  it("treats whitespace-only cue or answer as absent", () => {
    expect(isSchedulablePrompt("   ", "answer")).toBe(false);
    expect(isSchedulablePrompt("cue", "  \n ")).toBe(false);
    expect(resolvePromptLifecycle("   ", "answer")).toBe("draft");
    expect(resolvePromptLifecycle("cue", "  \n ")).toBe("draft");
  });
});

describe("buildMemoryPrompt", () => {
  it("seeds an FSRS card exactly when scheduled and never for a draft", () => {
    const scheduled = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back out of consideration",
      answerText: "遠慮",
      chunkId: "chunk-9",
      seedReview: seed
    });
    expect(scheduled.lifecycle).toBe("scheduled");
    expect(scheduled.review).toEqual(seed());
    expect(scheduled.chunkId).toBe("chunk-9");

    const draft = buildMemoryPrompt({
      id: toEntryId("prompt-2"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back",
      answerText: null,
      seedReview: seed
    });
    expect(draft.lifecycle).toBe("draft");
    expect(draft.review).toBeNull();
    expect(draft.chunkId).toBeNull();
  });

  it("does not evaluate the FSRS seed for a draft", () => {
    let seeded = 0;
    const draft = buildMemoryPrompt({
      id: toEntryId("prompt-3"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: "   ",
      seedReview: () => {
        seeded += 1;
        return seed();
      }
    });
    expect(draft.lifecycle).toBe("draft");
    expect(seeded).toBe(0);
  });

  it("freezes the result", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-4"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: "answer",
      seedReview: seed
    });
    expect(Object.isFrozen(prompt)).toBe(true);
  });
});

describe("memoryPromptOwner", () => {
  it("returns the note's owner for a prompt that belongs to it", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: "answer",
      seedReview: seed
    });
    expect(memoryPromptOwner(note({ userId: "owner-42" }), prompt)).toBe("owner-42");
  });

  it("throws when the prompt belongs to a different note", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("other-note") as EntryId,
      cueText: "cue",
      answerText: "answer",
      seedReview: seed
    });
    expect(() => memoryPromptOwner(note(), prompt)).toThrow(/does not belong/);
  });
});

describe("memoryPromptFaces", () => {
  it("shows cue as front and answer as back for a scheduled prompt", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back out of consideration",
      answerText: "遠慮",
      seedReview: seed
    });
    expect(memoryPromptFaces(prompt)).toEqual({
      front: "When holding back out of consideration",
      back: "遠慮"
    });
  });

  it("has no faces for a draft prompt", () => {
    const draft = buildMemoryPrompt({
      id: toEntryId("prompt-2"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: null,
      seedReview: seed
    });
    expect(memoryPromptFaces(draft)).toBeNull();
  });

  it("has no faces when a scheduled prompt somehow has a null answer", () => {
    const manual: MemoryPrompt = {
      id: toEntryId("prompt-3"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: null,
      chunkId: null,
      lifecycle: "scheduled",
      review: seed()
    };
    expect(memoryPromptFaces(manual)).toBeNull();
  });
});
