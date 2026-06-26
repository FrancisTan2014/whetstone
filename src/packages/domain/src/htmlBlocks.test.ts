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

  it("emits one figure block for a <figure> with an <img> and <figcaption>, in order", () => {
    const html = [
      "<p>before</p>",
      '<figure><img src="img/x.png" alt="A dot"/><figcaption>Cap <em>it</em></figcaption></figure>',
      "<p>after</p>"
    ].join("\n");

    const unit = decomposeHtmlChapter(html);

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["paragraph", "before"],
      ["figure", "Cap it"],
      ["paragraph", "after"]
    ]);
    const figure = unit.blocks[1];
    expect(figure?.image).toEqual({ alt: "A dot", src: "img/x.png" });
    expect(figure?.mdast).toMatchObject({ type: "paragraph" });
  });

  it("does not turn a figcaption into a heading block or the unit title", () => {
    const html = [
      '<figure><img src="img/x.png"/><figcaption>Caption text</figcaption></figure>',
      "<h1>Real Title</h1>",
      "<p>body</p>"
    ].join("\n");

    const unit = decomposeHtmlChapter(html);

    expect(unit.title).toBe("Real Title");
    expect(unit.blocks.map((block) => block.blockType)).toEqual(["figure", "heading", "paragraph"]);
    expect(
      unit.blocks.some(
        (block) => block.blockType === "heading" && block.plaintext === "Caption text"
      )
    ).toBe(false);
  });

  it("infers no title from a figure caption when the chapter has no heading", () => {
    const unit = decomposeHtmlChapter(
      '<figure><img src="img/x.png"/><figcaption>Just a caption</figcaption></figure>'
    );

    expect(unit.title).toBeUndefined();
    expect(unit.blocks.map((block) => block.blockType)).toEqual(["figure"]);
  });

  it("emits an image-only figure block for a bare top-level <img>", () => {
    const unit = decomposeHtmlChapter('<img src="img/y.jpg" alt=""/>');

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["figure", ""]
    ]);
    expect(unit.blocks[0]?.image).toEqual({ src: "img/y.jpg" });
  });

  it("detects an <img> nested inside a <figure>", () => {
    const unit = decomposeHtmlChapter(
      '<figure><div><img src="img/z.gif" alt="nested"/></div></figure>'
    );

    expect(unit.blocks.map((block) => block.blockType)).toEqual(["figure"]);
    expect(unit.blocks[0]?.image).toEqual({ alt: "nested", src: "img/z.gif" });
  });

  it("passes a <figure> without an <img> through the mdast pipeline (no figure block)", () => {
    const unit = decomposeHtmlChapter("<figure><figcaption>orphan</figcaption></figure>");

    expect(unit.blocks.some((block) => block.blockType === "figure")).toBe(false);
  });

  it("emits a caption-only figure when the <img> has no src", () => {
    const unit = decomposeHtmlChapter(
      "<figure><img alt='x'/><figcaption>Caption</figcaption></figure>"
    );

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["figure", "Caption"]
    ]);
    expect(unit.blocks[0]?.image).toBeUndefined();
  });

  it("yields an empty caption for a figure with an empty figcaption", () => {
    const unit = decomposeHtmlChapter(
      '<figure><img src="img/x.png"/><figcaption></figcaption></figure>'
    );

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["figure", ""]
    ]);
    expect(unit.blocks[0]?.image).toEqual({ src: "img/x.png" });
  });
});
