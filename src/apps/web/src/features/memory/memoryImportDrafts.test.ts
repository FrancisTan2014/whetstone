import { createTextDocument, documentText } from "@whetstone/document";
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

// The rich cue/answer are documents; read their plaintext to assert on the parsed content.
function cueText(draft: ImportDraft | undefined): string | undefined {
  return draft === undefined ? undefined : documentText(draft.cueDoc);
}

function answerText(draft: ImportDraft | undefined): string | undefined {
  return draft === undefined ? undefined : documentText(draft.answerDoc);
}

describe("draftsFromText", () => {
  it("parses each line into an editable draft with an id and rich cue/answer documents", () => {
    const drafts = draftsFromText("per = each\nserendipity", idMaker());
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ id: "id-1", context: "", separator: "=", note: null });
    expect(cueText(drafts[0])).toBe("per");
    expect(answerText(drafts[0])).toBe("each");
    expect(drafts[1]).toMatchObject({ id: "id-2", separator: null });
    expect(cueText(drafts[1])).toBe("serendipity");
    expect(answerText(drafts[1])).toBe("");
  });

  it("keeps indented lines as a draft's context string", () => {
    const [draft] = draftsFromText("push back -> pushback\n    resisted the plan", idMaker());
    expect(draft?.context).toBe("resisted the plan");
  });
});

describe("updateDraftIn", () => {
  it("patches only the matching draft", () => {
    const drafts = draftsFromText("a\nb", idMaker());
    const next = updateDraftIn(drafts, "id-1", { cueDoc: createTextDocument("alpha") });
    expect(cueText(next[0])).toBe("alpha");
    expect(cueText(next[1])).toBe("b");
  });

  it("leaves the list unchanged for an unknown id", () => {
    const drafts = draftsFromText("a", idMaker());
    expect(updateDraftIn(drafts, "missing", { cueDoc: createTextDocument("x") })).toEqual(drafts);
  });
});

describe("removeDraftFrom", () => {
  it("drops the matching draft and keeps the rest", () => {
    const drafts = draftsFromText("keep\ndrop", idMaker());
    const next = removeDraftFrom(drafts, "id-2");
    expect(next.map((draft) => documentText(draft.cueDoc))).toEqual(["keep"]);
  });
});

describe("undoSplitIn", () => {
  it("restores the heading as the cue for a proposed split, preserving other drafts", () => {
    const drafts = draftsFromText("per = each\nplain", idMaker());
    const next = undoSplitIn(drafts, "id-1");
    expect(next[0]).toMatchObject({ separator: null });
    expect(cueText(next[0])).toBe("per = each");
    expect(answerText(next[0])).toBe("");
    expect(cueText(next[1])).toBe("plain");
  });

  it("is a no-op for a draft that has no proposed split", () => {
    const drafts = draftsFromText("plain", idMaker());
    expect(cueText(undoSplitIn(drafts, "id-1")[0])).toBe("plain");
  });
});

describe("mergeDraftsAt", () => {
  it("folds the later draft into the earlier one's context", () => {
    const drafts = draftsFromText("alpha\nbeta\ngamma", idMaker());
    const next = mergeDraftsAt(drafts, 0);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ context: "beta" });
    expect(cueText(next[0])).toBe("alpha");
    expect(cueText(next[1])).toBe("gamma");
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
    expect(next[0]).toMatchObject({ context: "" });
    expect(cueText(next[0])).toBe("push back");
    expect(answerText(next[0])).toBe("pushback");
    expect(next[1]).toMatchObject({ context: "" });
    expect(cueText(next[1])).toBe("resisted the plan");
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
  it("drops blank-cue rows and carries the rich cue/answer documents into deposit items", () => {
    const make = idMaker();
    let drafts = draftsFromText("per = each\nserendipity", make);
    drafts = updateDraftIn(drafts, "id-2", { cueDoc: createTextDocument("   ") });
    expect(importableDrafts(drafts)).toHaveLength(1);
    expect(toImportItems(drafts)).toEqual([
      {
        captureSource: "import",
        noteText: "per",
        prompts: [
          {
            cueText: "per",
            answerText: "each",
            cueDoc: createTextDocument("per"),
            answerDoc: createTextDocument("each")
          }
        ]
      }
    ]);
  });

  it("folds context into the note body and saves an answerless row as a cue-only prompt", () => {
    const drafts: ImportDraft[] = [
      {
        id: "x",
        cueDoc: createTextDocument("term"),
        answerDoc: createTextDocument(""),
        context: "an example",
        separator: null,
        raw: "term",
        note: null
      }
    ];
    expect(toImportItems(drafts)).toEqual([
      {
        captureSource: "import",
        noteText: "term\n\nan example",
        prompts: [{ cueText: "term", cueDoc: createTextDocument("term") }]
      }
    ]);
  });
});
