// @vitest-environment jsdom
import { Editor, type Extensions } from "@tiptap/core";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BlockGutterHighlight,
  blockGutterHighlightKey,
  setBlockGutterTarget
} from "./blockGutterHighlight";
import { blockGutterHighlightClass } from "./blockGutterHighlight.tokens";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => [] as unknown as DOMRectList
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect()
  });
});

const extensions: Extensions = [
  ...(documentExtensions as unknown as Extensions),
  BlockGutterHighlight as unknown as Extensions[number]
];

let editors: Editor[] = [];

function makeEditor(content: DocumentNodeJSON): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ content, element, extensions });
  editors.push(editor);
  return editor;
}

function paragraphs(...texts: string[]): DocumentNodeJSON {
  return {
    content: texts.map((text) => ({ content: [{ text, type: "text" }], type: "paragraph" })),
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

function washedTexts(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll(`.${blockGutterHighlightClass}`)).map(
    (node) => node.textContent ?? ""
  );
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe("BlockGutterHighlight", () => {
  it("adds no decoration at rest", () => {
    const editor = makeEditor(paragraphs("One", "Two"));

    expect(washedTexts(editor)).toEqual([]);
  });

  it("washes the targeted top-level block", () => {
    const editor = makeEditor(paragraphs("One", "Two", "Three"));

    setBlockGutterTarget(editor, blockStart(editor, 1));

    expect(washedTexts(editor)).toEqual(["Two"]);
  });

  it("moves the wash when the target changes", () => {
    const editor = makeEditor(paragraphs("One", "Two", "Three"));

    setBlockGutterTarget(editor, blockStart(editor, 0));
    expect(washedTexts(editor)).toEqual(["One"]);

    setBlockGutterTarget(editor, blockStart(editor, 2));
    expect(washedTexts(editor)).toEqual(["Three"]);
  });

  it("clears the wash when the target is null", () => {
    const editor = makeEditor(paragraphs("One", "Two"));

    setBlockGutterTarget(editor, blockStart(editor, 0));
    expect(washedTexts(editor)).toEqual(["One"]);

    setBlockGutterTarget(editor, null);
    expect(washedTexts(editor)).toEqual([]);
  });

  it("keeps the wash on the same block as earlier blocks change height", () => {
    const editor = makeEditor(paragraphs("One", "Two"));

    setBlockGutterTarget(editor, blockStart(editor, 1));
    expect(washedTexts(editor)).toEqual(["Two"]);

    // An edit in the first block shifts the second block's position; the wash must follow it.
    editor.chain().setTextSelection(3).insertContent(" more").run();

    expect(washedTexts(editor)).toEqual(["Two"]);
  });

  it("clears the wash when the target block is deleted", () => {
    const editor = makeEditor(paragraphs("One", "Two"));

    const secondStart = blockStart(editor, 1);
    setBlockGutterTarget(editor, secondStart);
    expect(washedTexts(editor)).toEqual(["Two"]);

    // Remove the washed block entirely; its mapped position is deleted, so the wash clears.
    editor
      .chain()
      .command(({ dispatch, tr }) => {
        if (dispatch) {
          tr.delete(secondStart, editor.state.doc.content.size);
        }
        return true;
      })
      .run();

    expect(washedTexts(editor)).toEqual([]);
  });

  it("ignores an out-of-range target", () => {
    const editor = makeEditor(paragraphs("One"));

    setBlockGutterTarget(editor, 9999);

    expect(washedTexts(editor)).toEqual([]);
  });

  it("preserves the current wash when a malformed target meta is dispatched", () => {
    const editor = makeEditor(paragraphs("One", "Two"));

    setBlockGutterTarget(editor, blockStart(editor, 0));
    expect(washedTexts(editor)).toEqual(["One"]);

    // Only setBlockGutterTarget produces well-formed meta; any other shape is ignored and the wash is
    // left exactly where it was, rather than throwing or clearing on unexpected input.
    for (const malformed of [null, "not-an-object", {}, { target: "nope" }]) {
      editor.view.dispatch(editor.state.tr.setMeta(blockGutterHighlightKey, malformed));
      expect(washedTexts(editor)).toEqual(["One"]);
    }
  });
});
