import { describe, expect, it } from "vitest";

import { decomposeHtmlChapter } from "./htmlBlocks.js";

describe("decomposeHtmlChapter", () => {
  it("converts chapter XHTML into one ordered reading unit of blocks", () => {
    const html = [
      "<h1>Chapter One</h1>",
      "<p>Hello <em>world</em>.</p>",
      "<ul><li>a</li><li>b</li></ul>",
      "<blockquote>quote</blockquote>",
      "<pre><code>code</code></pre>"
    ].join("\n");

    const unit = decomposeHtmlChapter(html);

    expect(unit.title).toBe("Chapter One");
    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["heading", "Chapter One"],
      ["paragraph", "Hello world."],
      ["list", "ab"],
      ["blockquote", "quote"],
      ["code", "code"]
    ]);
    expect(unit.blocks[0]?.mdast).toMatchObject({ depth: 1, type: "heading" });
  });

  it("preserves CJK chapter text", () => {
    const unit = decomposeHtmlChapter("<h1>五帝本纪</h1><p>黄帝者，少典之子。</p>");

    expect(unit.title).toBe("五帝本纪");
    expect(unit.blocks.map((block) => block.plaintext)).toEqual(["五帝本纪", "黄帝者，少典之子。"]);
  });

  it("skips top-level nodes outside the supported block types", () => {
    const unit = decomposeHtmlChapter("<hr><p>kept</p>");

    expect(unit.blocks.map((block) => block.blockType)).toEqual(["paragraph"]);
  });

  it("has no title when the chapter has no heading", () => {
    const unit = decomposeHtmlChapter("<p>only a paragraph</p>");

    expect(unit.title).toBeUndefined();
    expect(unit.blocks).toHaveLength(1);
  });

  it("treats an empty heading as no title", () => {
    const unit = decomposeHtmlChapter("<h1>   </h1><p>body</p>");

    expect(unit.title).toBeUndefined();
    expect(unit.blocks.map((block) => block.blockType)).toEqual(["heading", "paragraph"]);
  });
});
