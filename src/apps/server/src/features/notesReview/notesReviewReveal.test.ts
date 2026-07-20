import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { resolveNoteReveal } from "./notesReviewReveal.js";

const noteBodyDoc = createTextDocument("The live note body.");
const noteBodyText = "The live note body.";

describe("resolveNoteReveal", () => {
  it("resolves a current_note prompt from the live note body, ignoring any answer columns", () => {
    expect(
      resolveNoteReveal({
        revealKind: "current_note",
        answerDoc: null,
        answerText: null,
        noteBodyDoc,
        noteBodyText
      })
    ).toEqual({ kind: "current_note", bodyDoc: noteBodyDoc, bodyText: noteBodyText });
  });

  it("resolves a legacy_custom prompt from its own preserved answer, ignoring the note body", () => {
    const answerDoc = createTextDocument("The preserved custom answer.");
    expect(
      resolveNoteReveal({
        revealKind: "legacy_custom",
        answerDoc,
        answerText: "The preserved custom answer.",
        noteBodyDoc,
        noteBodyText
      })
    ).toEqual({
      kind: "legacy_custom",
      answerDoc,
      answerText: "The preserved custom answer."
    });
  });

  it("fails loud when a legacy_custom prompt is missing its answer document", () => {
    expect(() =>
      resolveNoteReveal({
        revealKind: "legacy_custom",
        answerDoc: null,
        answerText: "orphaned text",
        noteBodyDoc,
        noteBodyText
      })
    ).toThrow(/reveal_shape/);
  });

  it("fails loud when a legacy_custom prompt is missing its answer text", () => {
    expect(() =>
      resolveNoteReveal({
        revealKind: "legacy_custom",
        answerDoc: createTextDocument("orphaned doc"),
        answerText: null,
        noteBodyDoc,
        noteBodyText
      })
    ).toThrow(/reveal_shape/);
  });

  it("resolves an expected_response prompt into a separately labeled Success check and Reference", () => {
    const successCheckDoc = createTextDocument("Names the two rules.");
    expect(
      resolveNoteReveal({
        revealKind: "expected_response",
        answerDoc: successCheckDoc,
        answerText: "Names the two rules.",
        noteBodyDoc,
        noteBodyText
      })
    ).toEqual({
      kind: "expected_response",
      successCheckDoc,
      successCheckText: "Names the two rules.",
      referenceDoc: noteBodyDoc,
      referenceText: noteBodyText
    });
  });

  it("fails loud when an expected_response prompt is missing its Success check document", () => {
    expect(() =>
      resolveNoteReveal({
        revealKind: "expected_response",
        answerDoc: null,
        answerText: "orphaned success check",
        noteBodyDoc,
        noteBodyText
      })
    ).toThrow(/reveal_shape/);
  });
});
