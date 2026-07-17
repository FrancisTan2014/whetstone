import { createTextDocument, documentText, type DocumentNodeJSON } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  draftsFromText,
  importableNoteDrafts,
  incompleteNoteDrafts,
  mergeDraftsAt,
  noteDocumentFromAnswerAndContext,
  noteHasSplittableContext,
  removeDraftFrom,
  splitContextIn,
  toImportNoteItems,
  undoSplitIn,
  updateDraftIn,
  type NoteImportDraft
} from "./notesImportDrafts";

// The plaintext of each top-level block of a Note document — the observable answer+context fold.
function paragraphs(doc: DocumentNodeJSON): ReadonlyArray<string> {
  return (doc.content ?? []).map(documentText);
}

let counter = 0;
function makeId(): string {
  counter += 1;
  return `id-${counter}`;
}

describe("noteDocumentFromAnswerAndContext (#661)", () => {
  it("uses the answer as the first paragraph", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext("each", null))).toEqual(["each"]);
  });

  it("appends each context line as its own paragraph after the answer", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext("pushback", "resisted\nagain"))).toEqual([
      "pushback",
      "resisted",
      "again"
    ]);
  });

  it("keeps context alone when there is no answer", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext(null, "just context"))).toEqual([
      "just context"
    ]);
  });

  it("drops a blank answer", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext("   ", null))).toEqual([""]);
  });

  it("yields a single blank paragraph when there is neither answer nor context", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext(null, null))).toEqual([""]);
  });

  it("preserves an empty context line as an empty paragraph", () => {
    expect(paragraphs(noteDocumentFromAnswerAndContext("x", "a\n\nb"))).toEqual(["x", "a", "", "b"]);
  });
});

describe("draftsFromText (#661)", () => {
  it("splits a heading on an explicit separator into Question and Note", () => {
    const [draft] = draftsFromText("per = each", makeId);
    expect(documentText(draft!.questionDoc)).toBe("per");
    expect(paragraphs(draft!.noteDoc)).toEqual(["each"]);
    expect(draft!.separator).toBe("=");
  });

  it("folds indented context into the same Note document, in source order", () => {
    const [draft] = draftsFromText("push back -> pushback\n    resisted the plan", makeId);
    expect(documentText(draft!.questionDoc)).toBe("push back");
    expect(paragraphs(draft!.noteDoc)).toEqual(["pushback", "resisted the plan"]);
  });

  it("leaves a Note blank when a heading has no separator", () => {
    const [draft] = draftsFromText("serendipity", makeId);
    expect(documentText(draft!.questionDoc)).toBe("serendipity");
    expect(documentText(draft!.noteDoc).trim()).toBe("");
    expect(draft!.separator).toBeNull();
  });

  it("preserves the pasted order across several rows", () => {
    const drafts = draftsFromText("a = 1\nb = 2\nc = 3", makeId);
    expect(drafts.map((draft) => documentText(draft.questionDoc))).toEqual(["a", "b", "c"]);
  });
});

describe("importable and incomplete partition (#661)", () => {
  it("treats a row with both a Question and a Note as importable", () => {
    const drafts = draftsFromText("per = each", makeId);
    expect(importableNoteDrafts(drafts)).toHaveLength(1);
    expect(incompleteNoteDrafts(drafts)).toHaveLength(0);
  });

  it("treats a Note-less row as incomplete, never silently dropping it", () => {
    const drafts = draftsFromText("serendipity", makeId);
    expect(importableNoteDrafts(drafts)).toHaveLength(0);
    expect(incompleteNoteDrafts(drafts)).toHaveLength(1);
  });

  it("treats a Question-less row as incomplete", () => {
    let [draft] = draftsFromText("per = each", makeId);
    const drafts = updateDraftIn([draft!], draft!.id, {
      questionDoc: createTextDocument("")
    });
    expect(incompleteNoteDrafts(drafts)).toHaveLength(1);
  });

  it("builds import items only from complete rows, in order", () => {
    const drafts = draftsFromText("a = 1\nlonely\nb = 2", makeId);
    const items = toImportNoteItems(drafts);
    expect(items).toHaveLength(2);
    expect(documentText(items[0]!.questionDoc)).toBe("a");
    expect(documentText(items[1]!.questionDoc)).toBe("b");
  });
});

describe("structural edits (#661)", () => {
  it("updates only the matching draft", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    const updated = updateDraftIn(drafts, drafts[1]!.id, { note: "flagged" });
    expect(updated[0]!.note).toBeNull();
    expect(updated[1]!.note).toBe("flagged");
  });

  it("removes the matching draft", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    const removed = removeDraftFrom(drafts, drafts[0]!.id);
    expect(removed).toHaveLength(1);
    expect(documentText(removed[0]!.questionDoc)).toBe("b");
  });

  it("undoes a proposed split, folding the answer back into the Question", () => {
    const drafts = draftsFromText("push back -> pushback", makeId);
    const undone = undoSplitIn(drafts, drafts[0]!.id);
    expect(documentText(undone[0]!.questionDoc)).toBe("push back -> pushback");
    expect(documentText(undone[0]!.noteDoc).trim()).toBe("");
    expect(undone[0]!.separator).toBeNull();
  });

  it("preserves a per-row note when undoing a split", () => {
    const drafts = updateDraftIn(draftsFromText("a -> 1", makeId), "id-does-not-match", {});
    const flagged = updateDraftIn(drafts, drafts[0]!.id, { note: "kept" });
    const undone = undoSplitIn(flagged, flagged[0]!.id);
    expect(undone[0]!.note).toBe("kept");
  });

  it("leaves a draft without a proposed split rebuilt but unchanged in text", () => {
    const drafts = draftsFromText("serendipity", makeId);
    const undone = undoSplitIn(drafts, drafts[0]!.id);
    expect(documentText(undone[0]!.questionDoc)).toBe("serendipity");
  });

  it("does not touch drafts whose id does not match an undo", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    const undone = undoSplitIn(drafts, drafts[0]!.id);
    expect(documentText(undone[1]!.questionDoc)).toBe("b");
  });

  it("merges a draft with the one after it, folding it into the Note", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    const merged = mergeDraftsAt(drafts, 0);
    expect(merged).toHaveLength(1);
    expect(documentText(merged[0]!.questionDoc)).toBe("a");
    expect(paragraphs(merged[0]!.noteDoc)).toEqual(["1", "b \u2192 2"]);
  });

  it("is a no-op when merging the last draft", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    expect(mergeDraftsAt(drafts, 1)).toBe(drafts);
  });

  it("is a no-op when merging an out-of-range index", () => {
    const drafts = draftsFromText("a = 1\nb = 2", makeId);
    expect(mergeDraftsAt(drafts, 5)).toBe(drafts);
  });

  it("splits trailing Note lines out into their own following draft", () => {
    const drafts = draftsFromText("push back -> pushback\n    resisted the plan", makeId);
    const split = splitContextIn(drafts, drafts[0]!.id, makeId);
    expect(split).toHaveLength(2);
    expect(paragraphs(split[0]!.noteDoc)).toEqual(["pushback"]);
    expect(documentText(split[1]!.questionDoc)).toBe("resisted the plan");
  });

  it("is a no-op splitting a draft with no context", () => {
    const drafts = draftsFromText("per = each", makeId);
    expect(splitContextIn(drafts, drafts[0]!.id, makeId)).toBe(drafts);
  });

  it("is a no-op splitting an unknown id", () => {
    const drafts = draftsFromText("per = each", makeId);
    expect(splitContextIn(drafts, "id-unknown", makeId)).toBe(drafts);
  });

  it("reports whether a Note has splittable context", () => {
    const withContext = draftsFromText("a -> 1\n    more", makeId);
    const withoutContext = draftsFromText("a -> 1", makeId);
    expect(noteHasSplittableContext(withContext[0]!)).toBe(true);
    expect(noteHasSplittableContext(withoutContext[0]!)).toBe(false);
  });

  it("handles a Note document with no blocks when reshaping", () => {
    const emptyNoteDraft: NoteImportDraft = {
      id: "empty",
      note: null,
      noteDoc: { type: "doc" },
      questionDoc: createTextDocument("q"),
      raw: "q",
      separator: null
    };
    expect(noteHasSplittableContext(emptyNoteDraft)).toBe(false);
    const merged = mergeDraftsAt([draftsFromText("a = 1", makeId)[0]!, emptyNoteDraft], 0);
    expect(paragraphs(merged[0]!.noteDoc)).toEqual(["1", "q"]);
  });
});
