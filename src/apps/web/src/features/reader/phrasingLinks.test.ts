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

  it("hoists a link's list items directly into a list parent (top-level case)", () => {
    // Block `d5bbd80e…` shape: the link is a direct child of the `list`, wrapping its items.
    const node = {
      type: "list",
      ordered: false,
      children: [
        {
          type: "link",
          url: "x",
          children: [
            { type: "listItem", children: [{ type: "text", value: "one" }] },
            { type: "listItem", children: [{ type: "text", value: "two" }] }
          ]
        }
      ]
    };

    // The items land directly under the list (already valid) — no extra wrapping list is added.
    expect(unwrapBlockLinks(asNode(node))).toEqual({
      type: "list",
      ordered: false,
      children: [
        { type: "listItem", children: [{ type: "text", value: "one" }] },
        { type: "listItem", children: [{ type: "text", value: "two" }] }
      ]
    });
  });

  it("re-wraps bare list items hoisted into a listItem so no listItem nests directly in a listItem", () => {
    // The failing EPUB shape (#162): a `link` whose children are bare `listItem`s sits inside a
    // `listItem`. Naively hoisting puts `listItem` directly inside `listItem` (invalid `<li><li>`).
    const node = {
      type: "listItem",
      children: [
        {
          type: "link",
          url: "x",
          children: [
            { type: "listItem", children: [{ type: "text", value: "one" }] },
            { type: "listItem", children: [{ type: "text", value: "two" }] }
          ]
        }
      ]
    };

    expect(unwrapBlockLinks(asNode(node))).toEqual({
      type: "listItem",
      children: [
        {
          type: "list",
          ordered: false,
          children: [
            { type: "listItem", children: [{ type: "text", value: "one" }] },
            { type: "listItem", children: [{ type: "text", value: "two" }] }
          ]
        }
      ]
    });
  });

  it("repairs a block-containing link nested deep in the tree without nesting listItem in listItem", () => {
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
      children: { children: { children: { type: string }[]; type: string }[] }[];
    };

    // The inner block-containing link is gone; the hoisted listItem is re-wrapped in a list so the
    // outer listItem's child is a `list` (valid `li > ul > li`), never a bare `listItem`.
    const wrapped = result.children[0]?.children[0];
    expect(wrapped?.type).toBe("list");
    expect(wrapped?.children[0]?.type).toBe("listItem");
  });
});
