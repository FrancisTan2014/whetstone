import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";

import { unwrapBlockLinks } from "./phrasingLinks";

// These fixtures are intentionally malformed mdast — a `link` (phrasing) containing block
// content — the exact shape rehype-remark yields for an EPUB `<a>` that wraps flow content.
// The strict mdast types forbid it, so inputs are cast the same way the renderer treats its
// untrusted stored node (`unknown`).
const asNode = (value: unknown): Nodes => value as Nodes;

describe("unwrapBlockLinks", () => {
  it("returns a leaf node (no children) unchanged", () => {
    const node = { type: "text", value: "hi" } as const;

    expect(unwrapBlockLinks(asNode(node))).toEqual(node);
  });

  it("leaves a phrasing-only link in place", () => {
    const node = {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "x",
          children: [{ type: "emphasis", children: [{ type: "text", value: "ref" }] }]
        }
      ]
    };

    // The link (all-phrasing descendants) is preserved so it still renders as link text.
    expect(unwrapBlockLinks(asNode(node))).toEqual(node);
  });

  it("unwraps a link that wraps block content, hoisting its children into the parent", () => {
    const node = {
      type: "listItem",
      children: [
        {
          type: "link",
          url: "x",
          children: [
            { type: "text", value: "parent" },
            {
              type: "list",
              ordered: false,
              children: [{ type: "listItem", children: [{ type: "text", value: "child" }] }]
            }
          ]
        }
      ]
    };

    expect(unwrapBlockLinks(asNode(node))).toEqual({
      type: "listItem",
      children: [
        { type: "text", value: "parent" },
        {
          type: "list",
          ordered: false,
          children: [{ type: "listItem", children: [{ type: "text", value: "child" }] }]
        }
      ]
    });
  });

  it("repairs a block-containing link nested deep in the tree", () => {
    const node = {
      type: "list",
      ordered: false,
      children: [
        {
          type: "listItem",
          children: [
            {
              type: "link",
              url: "x",
              children: [{ type: "listItem", children: [{ type: "text", value: "deep" }] }]
            }
          ]
        }
      ]
    };

    const result = unwrapBlockLinks(asNode(node)) as {
      children: { children: { type: string }[] }[];
    };

    // The inner block-containing link is gone; the hoisted listItem remains.
    expect(result.children[0]?.children[0]?.type).toBe("listItem");
  });
});
