import { describe, expect, it } from "vitest";

import {
  draftsFromText,
  importableDrafts,
  mergeDraftsAt,
  removeDraftFrom,
  splitContextIn,
  toImportItems,
  undoSplitIn,
  updateDraftIn,
  type ImportDraft
} from "./memoryImportDrafts";

function idMaker(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

describe("draftsFromText", () => {
  it("parses each line into an editable draft with an id and normalized empty fields", () => {
    const drafts = draftsFromText("per = each\nserendipity", idMaker());
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      id: "id-1",
      cue: "per",
      answer: "each",
      context: "",
      separator: "=",
      note: null
    });
    expect(drafts[1]).toMatchObject({
      id: "id-2",
      cue: "serendipity",
      answer: "",
      separator: null
    });
  });

  it("keeps indented lines as a draft's context string", () => {
    const [draft] = draftsFromText("push back -> pushback\n    resisted the plan", idMaker());
    expect(draft?.context).toBe("resisted the plan");
  });
});

describe("updateDraftIn", () => {
  it("patches only the matching draft", () => {
    const drafts = draftsFromText("a\nb", idMaker());
    const next = updateDraftIn(drafts, "id-1", { cue: "alpha" });
    expect(next[0]?.cue).toBe("alpha");
    expect(next[1]?.cue).toBe("b");
  });

  it("leaves the list unchanged for an unknown id", () => {
    const drafts = draftsFromText("a", idMaker());
    expect(updateDraftIn(drafts, "missing", { cue: "x" })).toEqual(drafts);
  });
});

describe("removeDraftFrom", () => {
  it("drops the matching draft and keeps the rest", () => {
    const drafts = draftsFromText("keep\ndrop", idMaker());
    const next = removeDraftFrom(drafts, "id-2");
    expect(next.map((draft) => draft.cue)).toEqual(["keep"]);
  });
});

describe("undoSplitIn", () => {
  it("restores the heading as the cue for a proposed split, preserving other drafts", () => {
    const drafts = draftsFromText("per = each\nplain", idMaker());
    const next = undoSplitIn(drafts, "id-1");
    expect(next[0]).toMatchObject({ cue: "per = each", answer: "", separator: null });
    expect(next[1]?.cue).toBe("plain");
  });

  it("is a no-op for a draft that has no proposed split", () => {
    const drafts = draftsFromText("plain", idMaker());
    expect(undoSplitIn(drafts, "id-1")[0]?.cue).toBe("plain");
  });
});

describe("mergeDraftsAt", () => {
  it("folds the later draft into the earlier one's context", () => {
    const drafts = draftsFromText("alpha\nbeta\ngamma", idMaker());
    const next = mergeDraftsAt(drafts, 0);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ cue: "alpha", context: "beta" });
    expect(next[1]?.cue).toBe("gamma");
  });

  it("is a no-op when there is no draft after the index", () => {
    const drafts = draftsFromText("alpha", idMaker());
    expect(mergeDraftsAt(drafts, 0)).toEqual(drafts);
  });
});

describe("splitContextIn", () => {
  it("promotes the context into its own following draft with a fresh id", () => {
    const make = idMaker();
    const drafts = draftsFromText("push back -> pushback\n    resisted the plan", make);
    const next = splitContextIn(drafts, "id-1", make);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ cue: "push back", answer: "pushback", context: "" });
    expect(next[1]).toMatchObject({ cue: "resisted the plan", context: "" });
    expect(next[1]?.id).toBe("id-2");
  });

  it("is a no-op for an unknown id", () => {
    const make = idMaker();
    const drafts = draftsFromText("a\n    b", make);
    expect(splitContextIn(drafts, "missing", make)).toEqual(drafts);
  });

  it("is a no-op when the draft has no context", () => {
    const make = idMaker();
    const drafts = draftsFromText("solo", make);
    expect(splitContextIn(drafts, "id-1", make)).toEqual(drafts);
  });
});

describe("importableDrafts / toImportItems", () => {
  it("drops blank-cue rows and builds deposit items with import capture source", () => {
    const make = idMaker();
    let drafts = draftsFromText("per = each\nserendipity", make);
    drafts = updateDraftIn(drafts, "id-2", { cue: "   " });
    expect(importableDrafts(drafts)).toHaveLength(1);
    expect(toImportItems(drafts)).toEqual([
      {
        captureSource: "import",
        noteText: "per",
        prompts: [{ cueText: "per", answerText: "each" }]
      }
    ]);
  });

  it("folds context into the note body and saves an answerless row as a cue-only prompt", () => {
    const drafts: ImportDraft[] = [
      {
        id: "x",
        cue: "term",
        answer: "",
        context: "an example",
        separator: null,
        raw: "term",
        note: null
      }
    ];
    expect(toImportItems(drafts)).toEqual([
      { captureSource: "import", noteText: "term\n\nan example", prompts: [{ cueText: "term" }] }
    ]);
  });
});
