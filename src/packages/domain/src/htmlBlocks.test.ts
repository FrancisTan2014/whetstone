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

  it("captures a figure whose image is an SVG <image xlink:href> wrapper (DDIA)", () => {
    const unit = decomposeHtmlChapter(
      '<figure><svg><image xlink:href="img/f5.png"/></svg><figcaption>Figure 5-1.</figcaption></figure>'
    );

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["figure", "Figure 5-1."]
    ]);
    expect(unit.blocks[0]?.image).toEqual({ src: "img/f5.png" });
  });

  it("captures a bare <svg><image href> wrapper and an <object data> embed as figures", () => {
    const svgUnit = decomposeHtmlChapter('<p><svg><image href="img/g.png"/></svg></p>');
    expect(svgUnit.blocks[0]?.image).toEqual({ src: "img/g.png" });

    const objUnit = decomposeHtmlChapter('<object data="img/o.png"></object>');
    expect(objUnit.blocks[0]?.image).toEqual({ src: "img/o.png" });
  });

  it("emits an image-only figure block for an <img> wrapped in a <p> (standalone figure)", () => {
    const unit = decomposeHtmlChapter('<p><img src="img/p.png" alt="diagram"/></p>');

    expect(unit.blocks.map((block) => block.blockType)).toEqual(["figure"]);
    expect(unit.blocks[0]?.image).toEqual({ alt: "diagram", src: "img/p.png" });
  });

  it("captures a standalone <img> and keeps an adjacent caption paragraph", () => {
    const unit = decomposeHtmlChapter(
      '<div><img src="img/q.png" alt="d"/></div><p>FIGURE 5-2. The plan.</p>'
    );

    expect(unit.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["figure", ""],
      ["paragraph", "FIGURE 5-2. The plan."]
    ]);
    expect(unit.blocks[0]?.image).toEqual({ alt: "d", src: "img/q.png" });
  });

  it("leaves a paragraph with text and an inline image to the mdast pipeline (not a figure)", () => {
    const unit = decomposeHtmlChapter('<p>See <img src="img/i.png"/> here.</p>');

    expect(unit.blocks.some((block) => block.blockType === "figure")).toBe(false);
  });

  it("leaves a wrapper with a nested-element caption and image to the pipeline (not a figure)", () => {
    const unit = decomposeHtmlChapter('<p><span>Figure A</span><img src="img/n.png"/></p>');

    expect(unit.blocks.some((block) => block.blockType === "figure")).toBe(false);
  });

  it("passes a <figure> without an <img> through the mdast pipeline (no figure block)", () => {
    const unit = decomposeHtmlChapter("<figure><figcaption>orphan</figcaption></figure>");

    expect(unit.blocks.some((block) => block.blockType === "figure")).toBe(false);
  });

  it("preserves a host element id as the block's anchor for in-work cross-references (#252)", () => {
    const unit = decomposeHtmlChapter(
      '<p id="intro">An opening.</p>' +
        '<figure id="fig5"><img src="img/f.png"/><figcaption>Figure 5-2.</figcaption></figure>' +
        "<p>No id here.</p>"
    );

    const byId = new Map(unit.blocks.map((block) => [block.anchorId, block.plaintext]));
    expect(byId.get("intro")).toBe("An opening.");
    expect(byId.get("fig5")).toBe("Figure 5-2.");
    // A block without a source id carries no anchor.
    expect(
      unit.blocks.find((block) => block.plaintext === "No id here.")?.anchorId
    ).toBeUndefined();
  });

  const noterefDataFlag = (node: unknown): unknown => {
    const visit = (current: { children?: unknown[]; data?: unknown; type?: string }): unknown => {
      if (current.type === "link" && current.data !== undefined) {
        return current.data;
      }
      for (const child of (current.children ?? []) as { type?: string }[]) {
        const found = visit(child);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    return visit(node as { children?: unknown[] });
  };

  it("pairs an EPUB3 noteref marker and its footnote into a two-way link (#250)", () => {
    const unit = decomposeHtmlChapter(
      '<p>Replication keeps a copy<sup><a epub:type="noteref" href="#fn-i" id="ref-i">i</a></sup>.</p>' +
        '<aside epub:type="footnote" id="fn-i"><p>There are other reasons too.</p></aside>'
    );

    const marker = unit.blocks.find((block) => block.plaintext.startsWith("Replication"));
    const note = unit.blocks.find((block) => block.plaintext.startsWith("There are other"));

    // Marker block is addressable by the marker's id; the note points back to it.
    expect(marker?.anchorId).toBe("ref-i");
    expect(marker?.backlinkAnchorId).toBeUndefined();
    expect(note?.anchorId).toBe("fn-i");
    expect(note?.backlinkAnchorId).toBe("ref-i");
    // The marker link is flagged so the reader renders it as a superscript control.
    expect(noterefDataFlag(marker?.mdast)).toEqual({ hProperties: { dataNoteref: "true" } });
  });

  it("synthesizes a marker anchor when a noteref has no id (#250)", () => {
    const unit = decomposeHtmlChapter(
      '<p>See note<sup><a href="#fn-1">1</a></sup>.</p>' +
        '<aside id="fn-1"><p>The note.</p></aside>'
    );

    const marker = unit.blocks.find((block) => block.plaintext.startsWith("See note"));
    const note = unit.blocks.find((block) => block.plaintext.startsWith("The note"));

    expect(marker?.anchorId).toBe("fn-1-ref");
    expect(note?.backlinkAnchorId).toBe("fn-1-ref");
  });

  it("detects a data-type noteref without a <sup> wrapper (#250)", () => {
    const unit = decomposeHtmlChapter(
      '<p>Body<a data-type="noteref" href="#n2" id="r2">2</a>.</p>' +
        '<aside id="n2"><p>Endnote.</p></aside>'
    );

    expect(unit.blocks.find((block) => block.plaintext.startsWith("Body"))?.anchorId).toBe("r2");
    expect(
      unit.blocks.find((block) => block.plaintext.startsWith("Endnote"))?.backlinkAnchorId
    ).toBe("r2");
  });

  it("keeps an explicit element id as the anchor over a contained marker, and skips an unmatched note backlink (#250)", () => {
    const unit = decomposeHtmlChapter(
      '<p id="para">Text<sup><a href="#missing" id="m">x</a></sup>.</p>'
    );

    const block = unit.blocks[0];
    // The paragraph's own id wins; no note block carries "#missing", so nothing gets a backlink.
    expect(block?.anchorId).toBe("para");
    expect(unit.blocks.every((candidate) => candidate.backlinkAnchorId === undefined)).toBe(true);
    // The marker is still flagged for superscript rendering.
    expect(noterefDataFlag(block?.mdast)).toEqual({ hProperties: { dataNoteref: "true" } });
  });

  it("leaves an ordinary in-page link and footnoteless chapter untouched (#250)", () => {
    const unit = decomposeHtmlChapter(
      '<p>See <a href="#fig5">Figure 5</a> for detail.</p><p>Plain text.</p>'
    );

    expect(unit.blocks.every((block) => block.backlinkAnchorId === undefined)).toBe(true);
    expect(unit.blocks.every((block) => block.anchorId === undefined)).toBe(true);
    // A non-noteref in-page link is not flagged as a superscript marker.
    expect(noterefDataFlag(unit.blocks[0]?.mdast)).toBeUndefined();
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

  it("strips parser position data from every node, including figure captions", () => {
    const unit = decomposeHtmlChapter(
      "<h1>Chapter</h1><p>A <em>rich</em> paragraph.</p>" +
        '<figure><img src="img/x.png" alt="dot"/><figcaption>Cap <em>tion</em>.</figcaption></figure>'
    );
    const nodes = unit.blocks.map((block) => block.mdast);

    expect(unit.blocks.map((block) => block.blockType)).toContain("figure");
    expect(nodes.every((node) => !hasPositionAnywhere(node))).toBe(true);
  });
});

// True if `position` appears on the node or any descendant — the property the decomposer strips.
function hasPositionAnywhere(node: unknown): boolean {
  if (typeof node !== "object" || node === null) {
    return false;
  }

  const record = node as { children?: unknown[]; position?: unknown };

  if (record.position !== undefined) {
    return true;
  }

  return (record.children ?? []).some((child) => hasPositionAnywhere(child));
}
