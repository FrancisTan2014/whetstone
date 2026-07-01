import { describe, expect, it } from "vitest";

import { stripFlankingFootnoteBrackets } from "./pmFootnotes";

// A footnote marker node (atom, no content).
function marker(refId?: string): Record<string, unknown> {
  return refId === undefined
    ? { type: "footnoteMarker" }
    : { attrs: { refId }, type: "footnoteMarker" };
}

function text(value: string): Record<string, unknown> {
  return { text: value, type: "text" };
}

describe("stripFlankingFootnoteBrackets", () => {
  it("removes a `[`/`]` pair directly flanking a marker", () => {
    const node = {
      content: [text("Data Guard ["), marker("fn2"), text("] and more.")],
      type: "paragraph"
    };

    const result = stripFlankingFootnoteBrackets(node) as { content: { text?: string }[] };

    expect(result.content[0]?.text).toBe("Data Guard ");
    expect(result.content[2]?.text).toBe(" and more.");
  });

  it("does not touch the input node (returns a fresh tree)", () => {
    const node = {
      content: [text("A ["), marker("fn1"), text("] B")],
      type: "paragraph"
    };
    const before = JSON.stringify(node);

    stripFlankingFootnoteBrackets(node);

    expect(JSON.stringify(node)).toBe(before);
  });

  it("leaves brackets when only one side flanks the marker", () => {
    const openOnly = {
      content: [text("only open ["), marker("fn1"), text(" close-less")],
      type: "paragraph"
    };
    const closeOnly = {
      content: [text("no open "), marker("fn1"), text("] close")],
      type: "paragraph"
    };

    const openResult = stripFlankingFootnoteBrackets(openOnly) as { content: { text?: string }[] };
    const closeResult = stripFlankingFootnoteBrackets(closeOnly) as {
      content: { text?: string }[];
    };

    expect(openResult.content[0]?.text).toBe("only open [");
    expect(closeResult.content[2]?.text).toBe("] close");
  });

  it("leaves a marker at the start or end of its content untouched", () => {
    const leadingMarker = { content: [marker("fn1"), text("] tail")], type: "paragraph" };
    const trailingMarker = { content: [text("head ["), marker("fn1")], type: "paragraph" };

    const leading = stripFlankingFootnoteBrackets(leadingMarker) as {
      content: { text?: string }[];
    };
    const trailing = stripFlankingFootnoteBrackets(trailingMarker) as {
      content: { text?: string }[];
    };

    expect(leading.content[1]?.text).toBe("] tail");
    expect(trailing.content[0]?.text).toBe("head [");
  });

  it("ignores a non-text neighbour (e.g. two adjacent markers)", () => {
    const node = {
      content: [text("["), marker("fn1"), marker("fn2"), text("]")],
      type: "paragraph"
    };

    const result = stripFlankingFootnoteBrackets(node) as { content: { text?: string }[] };

    expect(result.content[0]?.text).toBe("[");
    expect(result.content[3]?.text).toBe("]");
  });

  it("recurses into nested content", () => {
    const node = {
      content: [
        {
          content: [
            {
              content: [text("nested ["), marker("fn3"), text("] here")],
              type: "paragraph"
            }
          ],
          type: "listItem"
        }
      ],
      type: "bulletList"
    };

    const result = stripFlankingFootnoteBrackets(node) as {
      content: { content: { content: { text?: string }[] }[] }[];
    };
    const paragraph = result.content[0]?.content[0]?.content;

    expect(paragraph?.[0]?.text).toBe("nested ");
    expect(paragraph?.[2]?.text).toBe(" here");
  });

  it("returns a leaf node with no content unchanged", () => {
    const leaf = text("plain");

    expect(stripFlankingFootnoteBrackets(leaf)).toBe(leaf);
  });
});
