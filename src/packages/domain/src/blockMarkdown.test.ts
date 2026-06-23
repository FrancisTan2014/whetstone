import type { Heading, Html, List, Paragraph } from "mdast";
import { describe, expect, it } from "vitest";

import { blockToMarkdown } from "./blockMarkdown.js";

describe("blockToMarkdown", () => {
  it("serializes a paragraph with inline emphasis", () => {
    const node: Paragraph = {
      children: [{ children: [{ type: "text", value: "emphasized" }], type: "emphasis" }],
      type: "paragraph"
    };

    expect(blockToMarkdown(node)).toBe("*emphasized*");
  });

  it("serializes a heading at its original depth", () => {
    const node: Heading = {
      children: [{ type: "text", value: "Chapter One" }],
      depth: 2,
      type: "heading"
    };

    expect(blockToMarkdown(node)).toBe("## Chapter One");
  });

  it("serializes a GFM list with task items", () => {
    const node: List = {
      children: [
        {
          checked: true,
          children: [{ children: [{ type: "text", value: "done" }], type: "paragraph" }],
          type: "listItem"
        }
      ],
      ordered: false,
      type: "list"
    };

    expect(blockToMarkdown(node)).toBe("* [x] done");
  });

  it("keeps raw HTML as literal text so the renderer can sanitize it", () => {
    const node: Html = { type: "html", value: "<script>danger()</script>" };

    expect(blockToMarkdown(node)).toBe("<script>danger()</script>");
  });
});
