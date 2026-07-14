import { describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "./entry.js";
import {
  buildMemoryPrompt,
  captureSources,
  isCaptureSource,
  isReadyPrompt,
  memoryPromptFaces,
  memoryPromptOwner,
  promptLifecycles,
  reconcilePromptEdit,
  resolvePromptLifecycle,
  type MemoryNote,
  type MemoryPrompt
} from "./memory.js";

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
  it("has exactly draft and ready", () => {
    expect(promptLifecycles).toEqual(["draft", "ready"]);
  });
});

describe("isReadyPrompt / resolvePromptLifecycle", () => {
  it("is ready only when both cue and answer are meaningful", () => {
    expect(isReadyPrompt("cue", "answer")).toBe(true);
    expect(resolvePromptLifecycle("cue", "answer")).toBe("ready");
  });

  it("is draft when the answer is absent (no revealable answer)", () => {
    expect(isReadyPrompt("cue", null)).toBe(false);
    expect(resolvePromptLifecycle("cue", null)).toBe("draft");
  });

  it("treats whitespace-only cue or answer as absent", () => {
    expect(isReadyPrompt("   ", "answer")).toBe(false);
    expect(isReadyPrompt("cue", "  \n ")).toBe(false);
    expect(resolvePromptLifecycle("   ", "answer")).toBe("draft");
    expect(resolvePromptLifecycle("cue", "  \n ")).toBe("draft");
  });
});

describe("buildMemoryPrompt", () => {
  it("marks a prompt ready when both cue and answer are meaningful", () => {
    const ready = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back out of consideration",
      answerText: "遠慮",
      chunkId: "chunk-9"
    });
    expect(ready.lifecycle).toBe("ready");
    expect(ready.answerText).toBe("遠慮");
    expect(ready.chunkId).toBe("chunk-9");
  });

  it("marks a prompt draft when the answer is absent, defaulting chunkId to null", () => {
    const draft = buildMemoryPrompt({
      id: toEntryId("prompt-2"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back",
      answerText: null
    });
    expect(draft.lifecycle).toBe("draft");
    expect(draft.answerText).toBeNull();
    expect(draft.chunkId).toBeNull();
  });

  it("freezes the result", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-4"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: "answer"
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
      answerText: "answer"
    });
    expect(memoryPromptOwner(note({ userId: "owner-42" }), prompt)).toBe("owner-42");
  });

  it("throws when the prompt belongs to a different note", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("other-note") as EntryId,
      cueText: "cue",
      answerText: "answer"
    });
    expect(() => memoryPromptOwner(note(), prompt)).toThrow(/does not belong/);
  });
});

describe("memoryPromptFaces", () => {
  it("shows cue as front and answer as back for a ready prompt", () => {
    const prompt = buildMemoryPrompt({
      id: toEntryId("prompt-1"),
      noteId: toEntryId("note-1"),
      cueText: "When holding back out of consideration",
      answerText: "遠慮"
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
      answerText: null
    });
    expect(memoryPromptFaces(draft)).toBeNull();
  });

  it("has no faces when a ready prompt somehow has a null answer", () => {
    const manual: MemoryPrompt = {
      id: toEntryId("prompt-3"),
      noteId: toEntryId("note-1"),
      cueText: "cue",
      answerText: null,
      chunkId: null,
      lifecycle: "ready"
    };
    expect(memoryPromptFaces(manual)).toBeNull();
  });
});

describe("reconcilePromptEdit", () => {
  it("keeps the existing card when a ready prompt stays ready (never resets history)", () => {
    expect(reconcilePromptEdit("ready", "new cue", "new answer")).toEqual({
      lifecycle: "ready",
      reviewAction: "keep"
    });
  });

  it("seeds a fresh card when a draft becomes ready for the first time", () => {
    expect(reconcilePromptEdit("draft", "cue", "an answer")).toEqual({
      lifecycle: "ready",
      reviewAction: "seed"
    });
  });

  it("clears the card when a ready prompt loses its revealable answer (reverts to draft)", () => {
    expect(reconcilePromptEdit("ready", "cue", null)).toEqual({
      lifecycle: "draft",
      reviewAction: "clear"
    });
    expect(reconcilePromptEdit("ready", "cue", "   ")).toEqual({
      lifecycle: "draft",
      reviewAction: "clear"
    });
  });

  it("leaves an unready draft a draft", () => {
    expect(reconcilePromptEdit("draft", "cue", null)).toEqual({
      lifecycle: "draft",
      reviewAction: "clear"
    });
  });

  it("treats a blanked cue as unready even with an answer", () => {
    expect(reconcilePromptEdit("ready", "   ", "answer")).toEqual({
      lifecycle: "draft",
      reviewAction: "clear"
    });
  });
});
