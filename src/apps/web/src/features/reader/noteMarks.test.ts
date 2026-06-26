// @vitest-environment jsdom
import { render } from "@testing-library/react";
import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { RootContent } from "mdast";
import { toHast } from "mdast-util-to-hast";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { describe, expect, it } from "vitest";

import { applyNoteMarks, type NoteMark } from "./noteMarks";

function hastFor(mdast: RootContent): Root {
  return toHast({ type: "root", children: [mdast] }) as Root;
}

function renderMarked(mdast: RootContent, marks: ReadonlyArray<NoteMark>): HTMLElement {
  const tree = applyNoteMarks(hastFor(mdast), marks);
  const { container } = render(toJsxRuntime(tree, { Fragment, jsx, jsxs }) as React.JSX.Element);
  return container;
}

function mark(over: NoteMark): NoteMark {
  return over;
}

function markedText(container: HTMLElement, noteId: string): string {
  return Array.from(container.querySelectorAll(`[data-note-id="${noteId}"]`))
    .map((node) => node.textContent ?? "")
    .join("");
}

describe("applyNoteMarks", () => {
  it("underlines exactly the anchored characters of a multi-word range", () => {
    const paragraph: RootContent = {
      type: "paragraph",
      children: [{ type: "text", value: "A brown fox jumps." }]
    };
    // plaintext "A brown fox jumps." → "brown fox" is [2, 11)
    const container = renderMarked(paragraph, [
      mark({
        ariaLabel: "Note on “brown fox”",
        className: "noteMark--vocab",
        endOffset: 11,
        noteId: "n1",
        startOffset: 2
      })
    ]);

    const spans = container.querySelectorAll(".noteMark");
    expect(spans).toHaveLength(1);
    expect(markedText(container, "n1")).toBe("brown fox");
    // The unmarked remainder stays plain text in the same paragraph.
    expect(container.querySelector("p")?.textContent).toBe("A brown fox jumps.");
  });

  it("renders the mark span as an accessible, identifiable button target", () => {
    const paragraph: RootContent = {
      type: "paragraph",
      children: [{ type: "text", value: "one two" }]
    };
    const container = renderMarked(paragraph, [
      mark({
        ariaLabel: "Note on “one”",
        className: "noteMark--thought",
        endOffset: 3,
        noteId: "note-7",
        startOffset: 0
      })
    ]);

    const span = container.querySelector(".noteMark") as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect(span.getAttribute("role")).toBe("button");
    expect(span.getAttribute("tabindex")).toBe("0");
    expect(span.getAttribute("aria-label")).toBe("Note on “one”");
    expect(span.getAttribute("data-note-id")).toBe("note-7");
    expect(span.classList.contains("noteMark--thought")).toBe(true);
  });

  it("draws one continuous underline across emphasis, a link, and the text between", () => {
    const paragraph: RootContent = {
      type: "paragraph",
      children: [
        { type: "text", value: "The " },
        { type: "emphasis", children: [{ type: "text", value: "quick" }] },
        { type: "text", value: " " },
        { type: "link", url: "https://x", children: [{ type: "text", value: "brown" }] },
        { type: "text", value: " fox." }
      ]
    };
    // plaintext "The quick brown fox." → "quick brown" is [4, 15)
    const container = renderMarked(paragraph, [
      mark({
        ariaLabel: "Note on “quick brown”",
        className: "noteMark--expr",
        endOffset: 15,
        noteId: "span-note",
        startOffset: 4
      })
    ]);

    // One mark, but three spans (emphasis, the middle space, link) — all the same note.
    const spans = container.querySelectorAll(".noteMark");
    expect(spans.length).toBe(3);
    expect(markedText(container, "span-note")).toBe("quick brown");
    // Marked text inside the emphasis/link stays inside its formatting element.
    expect(container.querySelector("em .noteMark")?.textContent).toBe("quick");
    expect(container.querySelector("a .noteMark")?.textContent).toBe("brown");
  });

  it("renders two disjoint marks as independent underlines", () => {
    const paragraph: RootContent = {
      type: "paragraph",
      children: [{ type: "text", value: "alpha beta gamma" }]
    };
    // "alpha" [0,5), "gamma" [11,16)
    const container = renderMarked(paragraph, [
      mark({
        ariaLabel: "Note on “gamma”",
        className: "noteMark--vocab",
        endOffset: 16,
        noteId: "second",
        startOffset: 11
      }),
      mark({
        ariaLabel: "Note on “alpha”",
        className: "noteMark--expr",
        endOffset: 5,
        noteId: "first",
        startOffset: 0
      })
    ]);

    expect(markedText(container, "first")).toBe("alpha");
    expect(markedText(container, "second")).toBe("gamma");
    expect(container.querySelectorAll(".noteMark")).toHaveLength(2);
  });

  it("aligns offsets across a list, skipping the structural whitespace hast inserts", () => {
    const list: RootContent = {
      type: "list",
      ordered: false,
      children: [
        {
          type: "listItem",
          children: [{ type: "paragraph", children: [{ type: "text", value: "alpha" }] }]
        },
        {
          type: "listItem",
          children: [{ type: "paragraph", children: [{ type: "text", value: "beta" }] }]
        }
      ]
    };
    // plaintext "alphabeta" → [2,7) is "phabe", spanning the two items.
    const container = renderMarked(list, [
      mark({
        ariaLabel: "Note on “phabe”",
        className: "noteMark--vocab",
        endOffset: 7,
        noteId: "across",
        startOffset: 2
      })
    ]);

    expect(markedText(container, "across")).toBe("phabe");
  });

  it("aligns offsets across a table, skipping structural whitespace", () => {
    const table: RootContent = {
      type: "table",
      align: [null, null],
      children: [
        {
          type: "tableRow",
          children: [
            { type: "tableCell", children: [{ type: "text", value: "h1" }] },
            { type: "tableCell", children: [{ type: "text", value: "h2" }] }
          ]
        },
        {
          type: "tableRow",
          children: [
            { type: "tableCell", children: [{ type: "text", value: "c1" }] },
            { type: "tableCell", children: [{ type: "text", value: "c2" }] }
          ]
        }
      ]
    };
    // plaintext "h1h2c1c2" → [1,5) is "1h2c".
    const container = renderMarked(table, [
      mark({
        ariaLabel: "Note on “1h2c”",
        className: "noteMark--expr",
        endOffset: 5,
        noteId: "cells",
        startOffset: 1
      })
    ]);

    expect(markedText(container, "cells")).toBe("1h2c");
  });

  it("returns the tree untouched when there are no marks", () => {
    const paragraph: RootContent = {
      type: "paragraph",
      children: [{ type: "text", value: "plain" }]
    };
    const container = renderMarked(paragraph, []);
    expect(container.querySelector(".noteMark")).toBeNull();
    expect(container.textContent).toBe("plain");
  });

  it("preserves non-text, non-element nodes and root-level structural whitespace", () => {
    // A hand-built tree exercising the comment branch and a whitespace text node directly under
    // the root (parent tag undefined) — both must pass through without advancing the cursor.
    const tree: Root = {
      type: "root",
      children: [
        { type: "text", value: "\n" },
        { type: "comment", value: "keep me" },
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "word" }]
        }
      ]
    };
    const marked = applyNoteMarks(tree, [
      mark({
        ariaLabel: "Note on “word”",
        className: "noteMark--vocab",
        endOffset: 4,
        noteId: "w",
        startOffset: 0
      })
    ]);
    const { container } = render(
      toJsxRuntime(marked, { Fragment, jsx, jsxs }) as React.JSX.Element
    );
    expect(markedText(container, "w")).toBe("word");
  });
});
