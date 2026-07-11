// @vitest-environment jsdom
import { Editor, type Extensions } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import { afterEach, describe, expect, it } from "vitest";

import {
  blockIndexAt,
  canMoveBlockDown,
  canMoveBlockUp,
  canTurnBlockInto,
  deleteBlock,
  duplicateBlock,
  insertBlockAbove,
  insertBlockBelow,
  moveBlockDown,
  moveBlockUp,
  turnBlockInto
} from "./blockGutterCommands";

const extensions: Extensions = [...(documentExtensions as unknown as Extensions), UndoRedo];

let editors: Editor[] = [];

function makeEditor(content: DocumentNodeJSON): Editor {
  const editor = new Editor({ content, extensions });
  editors.push(editor);
  return editor;
}

// A doc of single-line paragraphs, each seeded with a stable id so id preservation/regeneration is
// observable. Positions before each top-level block are what the drag handle reports.
function paragraphs(...items: Array<{ id: string; text: string }>): DocumentNodeJSON {
  return {
    content: items.map((item) => ({
      attrs: { id: item.id },
      content: [{ text: item.text, type: "text" }],
      type: "paragraph"
    })),
    type: "doc"
  };
}

function blockStart(editor: Editor, index: number): number {
  let pos = 0;
  editor.state.doc.forEach((_node, offset, i) => {
    if (i === index) {
      pos = offset;
    }
  });
  return pos;
}

function topTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map((node) => node.type ?? "");
}

function topTexts(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map(
    (node) =>
      (node.content ?? []).map((child) => (child as { text?: string }).text ?? "").join("") ?? ""
  );
}

function allIds(node: DocumentNodeJSON): string[] {
  const id = node.attrs?.["id"];
  const own = typeof id === "string" ? [id] : [];
  return [...own, ...(node.content ?? []).flatMap((child) => allIds(child))];
}

function topIds(editor: Editor): Array<string | undefined> {
  return (editor.getJSON().content ?? []).map((node) => {
    const id = node.attrs?.["id"];
    return typeof id === "string" ? id : undefined;
  });
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe("block-gutter targeting and availability", () => {
  it("resolves the top-level block index for a boundary position and an inside position", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(blockIndexAt(editor, blockStart(editor, 0))).toBe(0);
    expect(blockIndexAt(editor, blockStart(editor, 1))).toBe(1);
    // A position inside the second block still resolves to that block.
    expect(blockIndexAt(editor, blockStart(editor, 1) + 1)).toBe(1);
  });

  it("returns null for an out-of-range position", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }));

    expect(blockIndexAt(editor, -1)).toBeNull();
    expect(blockIndexAt(editor, 9999)).toBeNull();
    // The end-of-document boundary resolves at depth 0 with no block after it (maybeChild returns
    // undefined), so there is no target block there either.
    expect(blockIndexAt(editor, editor.state.doc.content.size)).toBeNull();
  });

  it("treats every action as a no-op for an out-of-range position, leaving the document untouched", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));
    const before = editor.getJSON();
    const out = 9999;

    expect(canMoveBlockUp(editor, out)).toBe(false);
    expect(canMoveBlockDown(editor, out)).toBe(false);
    expect(canTurnBlockInto(editor, out)).toBe(false);
    expect(insertBlockAbove(editor, out)).toBe(false);
    expect(insertBlockBelow(editor, out)).toBe(false);
    expect(duplicateBlock(editor, out)).toBe(false);
    expect(moveBlockUp(editor, out)).toBe(false);
    expect(moveBlockDown(editor, out)).toBe(false);
    expect(deleteBlock(editor, out)).toBe(false);
    expect(turnBlockInto(editor, out, "turn-into-heading-1")).toBe(false);

    expect(editor.getJSON()).toEqual(before);
  });

  it("reports move availability from the block's position among its siblings", () => {
    const editor = makeEditor(
      paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" })
    );

    expect(canMoveBlockUp(editor, blockStart(editor, 0))).toBe(false);
    expect(canMoveBlockDown(editor, blockStart(editor, 0))).toBe(true);
    expect(canMoveBlockUp(editor, blockStart(editor, 1))).toBe(true);
    expect(canMoveBlockDown(editor, blockStart(editor, 1))).toBe(true);
    expect(canMoveBlockUp(editor, blockStart(editor, 2))).toBe(true);
    expect(canMoveBlockDown(editor, blockStart(editor, 2))).toBe(false);
  });

  it("reports Turn into unavailable for a code block and available for prose", () => {
    const editor = makeEditor({
      content: [
        { attrs: { id: "p" }, content: [{ text: "body", type: "text" }], type: "paragraph" },
        { attrs: { id: "c" }, content: [{ text: "code", type: "text" }], type: "codeBlock" }
      ],
      type: "doc"
    });

    expect(canTurnBlockInto(editor, blockStart(editor, 0))).toBe(true);
    expect(canTurnBlockInto(editor, blockStart(editor, 1))).toBe(false);
  });
});

describe("insert and duplicate assign fresh ids", () => {
  it("inserts an empty paragraph above the block, leaving existing ids intact", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(insertBlockAbove(editor, blockStart(editor, 1))).toBe(true);
    expect(topTexts(editor)).toEqual(["A", "", "B"]);
    const ids = topIds(editor);
    expect(ids[0]).toBe("a");
    expect(ids[2]).toBe("b");
    // The inserted paragraph received its own fresh, unique id.
    expect(typeof ids[1]).toBe("string");
    expect(ids[1]).not.toBe("a");
    expect(ids[1]).not.toBe("b");
  });

  it("inserts an empty paragraph below the block", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(insertBlockBelow(editor, blockStart(editor, 0))).toBe(true);
    expect(topTexts(editor)).toEqual(["A", "", "B"]);
  });

  it("duplicates the block below with a fresh id that never copies the source id", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(duplicateBlock(editor, blockStart(editor, 0))).toBe(true);
    expect(topTexts(editor)).toEqual(["A", "A", "B"]);

    const ids = allIds(editor.getJSON() as DocumentNodeJSON);
    // Every id in the document remains unique after duplication.
    expect(new Set(ids).size).toBe(ids.length);
    const tops = topIds(editor);
    expect(tops[0]).toBe("a");
    expect(tops[1]).not.toBe("a");
    expect(typeof tops[1]).toBe("string");
  });

  it("duplicates a nested container as one unit with a fully fresh subtree", () => {
    const editor = makeEditor({
      content: [
        {
          attrs: { id: "list" },
          content: [
            {
              attrs: { id: "li" },
              content: [
                { attrs: { id: "p" }, content: [{ text: "item", type: "text" }], type: "paragraph" }
              ],
              type: "listItem"
            }
          ],
          type: "bulletList"
        }
      ],
      type: "doc"
    });

    expect(duplicateBlock(editor, blockStart(editor, 0))).toBe(true);
    expect(topTypes(editor)).toEqual(["bulletList", "bulletList"]);

    const ids = allIds(editor.getJSON() as DocumentNodeJSON);
    expect(new Set(ids).size).toBe(ids.length);
    // None of the original subtree ids leaked into the copy.
    const copy = (editor.getJSON() as DocumentNodeJSON).content?.[1];
    expect(copy).toBeDefined();
    expect(allIds(copy as DocumentNodeJSON).some((id) => ["list", "li", "p"].includes(id))).toBe(
      false
    );
  });
});

describe("moving a block preserves every id", () => {
  it("moves a block up, swapping order while keeping all ids", () => {
    const editor = makeEditor(
      paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" })
    );

    expect(moveBlockUp(editor, blockStart(editor, 1))).toBe(true);
    expect(topTexts(editor)).toEqual(["B", "A", "C"]);
    expect(topIds(editor)).toEqual(["b", "a", "c"]);
  });

  it("moves a block down, swapping order while keeping all ids", () => {
    const editor = makeEditor(
      paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" })
    );

    expect(moveBlockDown(editor, blockStart(editor, 1))).toBe(true);
    expect(topTexts(editor)).toEqual(["A", "C", "B"]);
    expect(topIds(editor)).toEqual(["a", "c", "b"]);
  });

  it("refuses to move the first block up or the last block down without changing the document", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));
    const before = editor.getJSON();

    expect(moveBlockUp(editor, blockStart(editor, 0))).toBe(false);
    expect(moveBlockDown(editor, blockStart(editor, 1))).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("moves an atomic container (a list) as one unit", () => {
    const editor = makeEditor({
      content: [
        { attrs: { id: "p" }, content: [{ text: "P", type: "text" }], type: "paragraph" },
        {
          attrs: { id: "list" },
          content: [
            {
              attrs: { id: "li" },
              content: [
                {
                  attrs: { id: "lp" },
                  content: [{ text: "item", type: "text" }],
                  type: "paragraph"
                }
              ],
              type: "listItem"
            }
          ],
          type: "bulletList"
        }
      ],
      type: "doc"
    });

    expect(moveBlockUp(editor, blockStart(editor, 1))).toBe(true);
    expect(topTypes(editor)).toEqual(["bulletList", "paragraph"]);
    const ids = allIds(editor.getJSON() as DocumentNodeJSON);
    expect(ids).toContain("list");
    expect(ids).toContain("li");
    expect(ids).toContain("lp");
    expect(ids).toContain("p");
  });
});

describe("deleting a block", () => {
  it("deletes a block among several, keeping the remaining ids", () => {
    const editor = makeEditor(
      paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" })
    );

    expect(deleteBlock(editor, blockStart(editor, 1))).toBe(true);
    expect(topTexts(editor)).toEqual(["A", "C"]);
    expect(topIds(editor)).toEqual(["a", "c"]);
  });

  it("leaves one empty paragraph when the final block is deleted", () => {
    const editor = makeEditor(paragraphs({ id: "only", text: "Only" }));

    expect(deleteBlock(editor, blockStart(editor, 0))).toBe(true);
    expect(topTypes(editor)).toEqual(["paragraph"]);
    expect(topTexts(editor)).toEqual([""]);
  });
});

describe("turning a block into another type", () => {
  it("turns the targeted block into a heading, preserving its id", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(turnBlockInto(editor, blockStart(editor, 1), "heading-2")).toBe(true);
    const second = (editor.getJSON() as DocumentNodeJSON).content?.[1];
    expect(second?.type).toBe("heading");
    expect(second?.attrs?.["level"]).toBe(2);
    expect(second?.attrs?.["id"]).toBe("b");
  });

  it("keeps ids unique when turning a block into a wrapping list", () => {
    const editor = makeEditor(paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }));

    expect(turnBlockInto(editor, blockStart(editor, 0), "bullet-list")).toBe(true);
    expect(topTypes(editor)[0]).toBe("bulletList");
    expect(topIds(editor)[0]).toBe("a");
    const ids = allIds(editor.getJSON() as DocumentNodeJSON);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns false for an unknown command id and for a code block", () => {
    const editor = makeEditor({
      content: [
        { attrs: { id: "p" }, content: [{ text: "body", type: "text" }], type: "paragraph" },
        { attrs: { id: "c" }, content: [{ text: "code", type: "text" }], type: "codeBlock" }
      ],
      type: "doc"
    });

    expect(turnBlockInto(editor, blockStart(editor, 0), "does-not-exist")).toBe(false);
    expect(turnBlockInto(editor, blockStart(editor, 1), "heading-1")).toBe(false);
  });
});

describe("every gutter action is a single undo step", () => {
  it("restores the exact prior document after one undo", () => {
    const cases: Array<(editor: Editor, pos: number) => boolean> = [
      insertBlockAbove,
      insertBlockBelow,
      duplicateBlock,
      moveBlockUp,
      moveBlockDown,
      deleteBlock,
      (editor, pos) => turnBlockInto(editor, pos, "heading-1")
    ];

    for (const run of cases) {
      const editor = makeEditor(
        paragraphs({ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" })
      );
      const before = editor.getJSON();

      expect(run(editor, blockStart(editor, 1))).toBe(true);
      expect(editor.getJSON()).not.toEqual(before);

      editor.commands.undo();
      expect(editor.getJSON()).toEqual(before);
    }
  });
});
