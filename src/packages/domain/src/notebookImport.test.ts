import { describe, expect, it } from "vitest";

import {
  mergeNotebookDrafts,
  parseNotebookList,
  splitNotebookDraftContext,
  undoNotebookSplit,
  type ParsedNotebookDraft
} from "./notebookImport.js";

describe("parseNotebookList", () => {
  it("starts one draft per non-indented nonblank line", () => {
    const drafts = parseNotebookList("per\npush back\nkanmusu");
    expect(drafts.map((draft) => draft.cue)).toEqual(["per", "push back", "kanmusu"]);
    expect(drafts.every((draft) => draft.answer === null && draft.separator === null)).toBe(true);
  });

  it("attaches indented lines as the preceding draft's context", () => {
    const drafts = parseNotebookList("push back\n    He pushed back on the deadline.\n\ttwice");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.context).toBe("He pushed back on the deadline.\ntwice");
  });

  it("treats a blank line as a separator that closes the current group", () => {
    const drafts = parseNotebookList("word\n    example one\n\n    example two");
    // The blank line closes the first draft, so the later indented line starts a fresh draft.
    expect(drafts.map((draft) => draft.cue)).toEqual(["word", "example two"]);
    expect(drafts[0]?.context).toBe("example one");
    expect(drafts[1]?.context).toBeNull();
  });

  it("splits on `=`", () => {
    const [draft] = parseNotebookList("per = each");
    expect(draft).toMatchObject({ cue: "per", answer: "each", separator: "=" });
  });

  it("splits on `->`", () => {
    const [draft] = parseNotebookList("push back -> pushback");
    expect(draft).toMatchObject({ cue: "push back", answer: "pushback", separator: "->" });
  });

  it("splits on the arrow `\u2192`", () => {
    const [draft] = parseNotebookList("dog \u2192 \u72d7");
    expect(draft).toMatchObject({ cue: "dog", answer: "\u72d7", separator: "\u2192" });
  });

  it("splits on the first `:` only", () => {
    const [draft] = parseNotebookList("ratio: a relation: two amounts");
    expect(draft).toMatchObject({
      cue: "ratio",
      answer: "a relation: two amounts",
      separator: ":"
    });
  });

  it("chooses the leftmost recognized separator when several are present", () => {
    const [draft] = parseNotebookList("a -> b = c");
    expect(draft).toMatchObject({ cue: "a", answer: "b = c", separator: "->" });
  });

  it("does not split when a side would be blank, keeping the whole heading as the cue", () => {
    const dangling = parseNotebookList("word ->")[0];
    expect(dangling).toMatchObject({ cue: "word ->", answer: null, separator: null });
    const leading = parseNotebookList("-> word")[0];
    expect(leading).toMatchObject({ cue: "-> word", answer: null, separator: null });
  });

  it("never infers a split from prose like `vs`, commas, or a dash inside a word", () => {
    const [draft] = parseNotebookList("affect vs effect, a common mix-up");
    expect(draft).toMatchObject({
      cue: "affect vs effect, a common mix-up",
      answer: null,
      separator: null
    });
  });

  it("keeps a split heading together with its indented context", () => {
    const [draft] = parseNotebookList("push back -> pushback\n    resisted the plan");
    expect(draft).toMatchObject({
      cue: "push back",
      answer: "pushback",
      separator: "->",
      context: "resisted the plan"
    });
  });

  it("preserves the original pasted text of each draft in raw", () => {
    const [draft] = parseNotebookList("per = each\n    per annum");
    expect(draft?.raw).toBe("per = each\n    per annum");
  });

  it("ignores an empty or whitespace-only paste", () => {
    expect(parseNotebookList("")).toEqual([]);
    expect(parseNotebookList("   \n\n\t")).toEqual([]);
  });

  it("handles CRLF newlines", () => {
    const drafts = parseNotebookList("per\r\n    each\r\npush");
    expect(drafts.map((draft) => draft.cue)).toEqual(["per", "push"]);
    expect(drafts[0]?.context).toBe("each");
  });
});

describe("undoNotebookSplit", () => {
  it("restores the original heading as the cue and clears the answer", () => {
    const [draft] = parseNotebookList("push back -> pushback\n    kept context");
    const undone = undoNotebookSplit(draft as ParsedNotebookDraft);
    expect(undone).toMatchObject({
      cue: "push back -> pushback",
      answer: null,
      separator: null,
      context: "kept context"
    });
  });

  it("returns a draft with no proposed split unchanged", () => {
    const [draft] = parseNotebookList("bare term");
    expect(undoNotebookSplit(draft as ParsedNotebookDraft)).toBe(draft);
  });

  it("restores the heading for a split draft that has no context", () => {
    const [draft] = parseNotebookList("per = each");
    expect(undoNotebookSplit(draft as ParsedNotebookDraft)).toMatchObject({
      cue: "per = each",
      answer: null,
      separator: null,
      context: null
    });
  });
});

describe("mergeNotebookDrafts", () => {
  it("keeps the earlier cue/answer and folds all of the later draft's text into the context", () => {
    const [earlier, later] = parseNotebookList("per = each\n    per annum\ndiem = day");
    const merged = mergeNotebookDrafts(
      earlier as ParsedNotebookDraft,
      later as ParsedNotebookDraft
    );
    expect(merged).toMatchObject({ cue: "per", answer: "each", separator: null });
    expect(merged.context).toBe("per annum\ndiem \u2192 day");
  });

  it("merges two bare drafts, preserving the later term as context", () => {
    const [earlier, later] = parseNotebookList("alpha\nbeta");
    const merged = mergeNotebookDrafts(
      earlier as ParsedNotebookDraft,
      later as ParsedNotebookDraft
    );
    expect(merged).toMatchObject({ cue: "alpha", answer: null, context: "beta" });
  });
});

describe("splitNotebookDraftContext", () => {
  it("promotes the context into its own following draft", () => {
    const [draft] = parseNotebookList("push back -> pushback\n    resist\n    example line");
    const result = splitNotebookDraftContext(draft as ParsedNotebookDraft);
    expect(result).not.toBeNull();
    const [remainder, promoted] = result as readonly [ParsedNotebookDraft, ParsedNotebookDraft];
    expect(remainder).toMatchObject({ cue: "push back", answer: "pushback", context: null });
    expect(promoted).toMatchObject({ cue: "resist", answer: null, context: "example line" });
  });

  it("returns null when there is no context to promote", () => {
    const [draft] = parseNotebookList("solo term");
    expect(splitNotebookDraftContext(draft as ParsedNotebookDraft)).toBeNull();
  });

  it("promotes a single-line context with no remaining context lines", () => {
    const [draft] = parseNotebookList("per = each\n    per annum");
    const result = splitNotebookDraftContext(draft as ParsedNotebookDraft);
    const [remainder, promoted] = result as readonly [ParsedNotebookDraft, ParsedNotebookDraft];
    expect(remainder).toMatchObject({ cue: "per", answer: "each", context: null });
    expect(promoted).toMatchObject({ cue: "per annum", answer: null, context: null });
  });
});
