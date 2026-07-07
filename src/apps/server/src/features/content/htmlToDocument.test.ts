import { describe, expect, it } from "vitest";

import { isValidDocument, parseDocument, type DocumentNodeJSON } from "@whetstone/document";

import { htmlToDocument } from "./htmlToDocument.js";

// Synthetic, structurally-faithful O'Reilly HTMLBook fixtures with neutral placeholder text. The real
// DDIA HTML is copyrighted, so these reproduce the publisher's element shapes (figures, definition
// lists, admonitions, calloutlists, endnote markers) without any of its prose.

// Concatenate the text of a node's whole subtree, so assertions check captured text without depending
// on the exact inline-node shape.
function textOf(node: DocumentNodeJSON): string {
  if (node.text !== undefined) {
    return node.text;
  }

  return (node.content ?? []).map(textOf).join("");
}

function blocksOfType(
  blocks: ReadonlyArray<{ type: string; node: DocumentNodeJSON }>,
  type: string
) {
  return blocks.filter((block) => block.type === type);
}

function childrenOf(node: DocumentNodeJSON): DocumentNodeJSON[] {
  return node.content ?? [];
}

function findDescendant(node: DocumentNodeJSON, type: string): DocumentNodeJSON | undefined {
  if (node.type === type) {
    return node;
  }

  for (const child of childrenOf(node)) {
    const found = findDescendant(child, type);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

describe("htmlToDocument", () => {
  it("decomposes O'Reilly figures into figure/image/caption blocks, including a bare figure", () => {
    const captioned = Array.from(
      { length: 14 },
      (_unused, index) =>
        `<figure><img src="fig-${index}.png" alt="Figure ${index} alt"/>` +
        `<figcaption>Caption ${index} text.</figcaption></figure>`
    ).join("");
    const html = `${captioned}<figure><img src="bare.png"/></figure>`;

    const { blocks, doc, evidence } = htmlToDocument(html);
    const figures = blocksOfType(blocks, "figure");

    expect(figures).toHaveLength(15);

    const first = figures[0]!.node;
    const image = findDescendant(first, "image")!;

    expect(image.attrs).toMatchObject({ alt: "Figure 0 alt", src: "fig-0.png" });
    expect(textOf(findDescendant(first, "figureCaption")!)).toBe("Caption 0 text.");

    const withCaption = figures.filter(
      (figure) => findDescendant(figure.node, "figureCaption") !== undefined
    );

    expect(withCaption).toHaveLength(14);

    const bare = figures.find(
      (figure) => findDescendant(figure.node, "figureCaption") === undefined
    )!;

    expect(findDescendant(bare.node, "image")!.attrs).toMatchObject({ alt: null, src: "bare.png" });
    expect(evidence).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
  });

  it("ingests a definition list, an admonition callout, and calloutlist/ordered lists", () => {
    const html =
      "<dl><dt>Services</dt><dd>Online request/response.</dd>" +
      "<dt>Batch</dt><dd>Bounded input.</dd>" +
      "<dt>Stream</dt><dd>Unbounded input.</dd></dl>" +
      '<div data-type="note"><p>This is an admonition.</p></div>' +
      "<ul><li>A bullet.</li></ul>" +
      '<ol class="calloutlist"><li>First step.</li><li>Second step.</li></ol>' +
      '<ol start="5"><li>Continues.</li></ol>';

    const { blocks, doc, evidence } = htmlToDocument(html);

    const list = blocksOfType(blocks, "definitionList")[0]!.node;
    const childTypes = childrenOf(list).map((child) => child.type);

    expect(childTypes).toEqual([
      "definitionTerm",
      "definitionDescription",
      "definitionTerm",
      "definitionDescription",
      "definitionTerm",
      "definitionDescription"
    ]);
    expect(textOf(childrenOf(list)[0]!)).toBe("Services");
    expect(textOf(childrenOf(list)[1]!)).toBe("Online request/response.");

    const callout = blocksOfType(blocks, "callout")[0]!;

    expect(callout.node.attrs).toMatchObject({ kind: "note", marker: null });
    expect(textOf(callout.node)).toBe("This is an admonition.");

    const orderedLists = blocksOfType(blocks, "orderedList");

    expect(orderedLists[0]!.node.attrs).toMatchObject({ start: 1 });
    const firstItem = childrenOf(orderedLists[0]!.node)[0]!;
    expect(firstItem.type).toBe("listItem");
    expect(childrenOf(firstItem)).toHaveLength(1);
    expect(childrenOf(firstItem)[0]!.type).toBe("paragraph");
    expect(textOf(firstItem)).toBe("First step.");
    expect(orderedLists[1]!.node.attrs).toMatchObject({ start: 5 });

    expect(blocksOfType(blocks, "bulletList")).toHaveLength(1);
    expect(evidence).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
  });

  it("ingests heading, blockquote, and a table with spanned cells", () => {
    const html =
      "<h2>Chapter Heading</h2>" +
      "<blockquote><p>Quoted line.</p></blockquote>" +
      '<table><tr><th colspan="2">Header</th></tr>' +
      '<tr><td>A</td><td rowspan="2">B</td></tr></table>';

    const { blocks } = htmlToDocument(html);

    const heading = blocksOfType(blocks, "heading")[0]!;

    expect(heading.node.attrs).toMatchObject({ level: 2 });
    expect(textOf(heading.node)).toBe("Chapter Heading");

    expect(textOf(blocksOfType(blocks, "blockquote")[0]!.node)).toBe("Quoted line.");

    const table = blocksOfType(blocks, "table")[0]!.node;
    const header = findDescendant(table, "tableHeader")!;

    expect(header.attrs).toMatchObject({ colspan: 2, rowspan: 1 });

    const cells = childrenOf(childrenOf(table)[1]!);

    expect(cells[0]!.attrs).toMatchObject({ colspan: 1, rowspan: 1 });
    expect(cells[1]!.attrs).toMatchObject({ colspan: 1, rowspan: 2 });
  });

  it("reads code-block language from data attribute, language- class, or neither", () => {
    const html =
      '<pre data-code-language="python">print()</pre>' +
      "<pre>plain text</pre>" +
      '<pre class="hljs language-js">const x = 1;</pre>' +
      '<pre class="sourcecode">no lang token</pre>';

    const { blocks } = htmlToDocument(html);
    const codeBlocks = blocksOfType(blocks, "codeBlock");

    expect(codeBlocks.map((block) => block.node.attrs?.["language"])).toEqual([
      "python",
      null,
      "js",
      null
    ]);
    expect(textOf(codeBlocks[0]!.node)).toBe("print()");
  });

  it("captures footnote markers (href, data-target, or unresolved) and their target", () => {
    const html =
      '<p>First reference<a data-type="noteref" href="#fn9">9</a>.</p>' +
      '<p>Second reference<a data-type="noteref" data-target="fn12">12</a>.</p>' +
      '<p>Third reference<a data-type="noteref" href="endnotes.html">x</a>.</p>' +
      '<aside data-type="footnote" id="fn9"><p>The ninth note.</p></aside>';

    const { blocks } = htmlToDocument(html);
    const paragraphs = blocksOfType(blocks, "paragraph");

    const marker0 = findDescendant(paragraphs[0]!.node, "footnoteMarker")!;
    expect(marker0.attrs).toMatchObject({
      label: "9",
      noteKind: "footnote",
      refFile: null,
      refId: "fn9"
    });

    const marker1 = findDescendant(paragraphs[1]!.node, "footnoteMarker")!;
    expect(marker1.attrs).toMatchObject({ label: "12", refFile: null, refId: "fn12" });

    const marker2 = findDescendant(paragraphs[2]!.node, "footnoteMarker")!;
    expect(marker2.attrs).toMatchObject({ label: "x", refFile: null, refId: null });

    const target = blocksOfType(blocks, "footnoteTarget")[0]!;
    expect(target.node.attrs).toMatchObject({ refId: "fn9" });
    expect(textOf(target.node)).toBe("The ninth note.");
  });

  it("captures the file part of a cross-file endnote marker and normalizes an empty id to null", () => {
    const html =
      '<p>Cross reference<a data-type="noteref" href="../notes.xhtml#fn12">12</a>.</p>' +
      '<p>Empty target<a data-type="noteref" href="notes.xhtml#">y</a>.</p>';

    const { blocks } = htmlToDocument(html);
    const paragraphs = blocksOfType(blocks, "paragraph");

    const crossFile = findDescendant(paragraphs[0]!.node, "footnoteMarker")!;
    expect(crossFile.attrs).toMatchObject({ refFile: "../notes.xhtml", refId: "fn12" });

    const emptyId = findDescendant(paragraphs[1]!.node, "footnoteMarker")!;
    expect(emptyId.attrs).toMatchObject({ refFile: "notes.xhtml", refId: null });
  });

  it("lifts a block's source-HTML id into IngestedBlock.anchorId without leaking it into node JSON", () => {
    const html =
      '<h2 id="sec-intro">Introduction</h2>' +
      '<p id="para-1">A paragraph with an id.</p>' +
      "<p>A paragraph without an id.</p>";

    const { blocks } = htmlToDocument(html);
    const [heading, withId, withoutId] = blocks as ReadonlyArray<{
      anchorId: string | null;
      node: DocumentNodeJSON;
    }>;

    expect(heading!.anchorId).toBe("sec-intro");
    expect(withId!.anchorId).toBe("para-1");
    expect(withoutId!.anchorId).toBeNull();

    // The addressing id is metadata, not render content: it must not survive into the stored node JSON.
    for (const block of blocks) {
      expect(JSON.stringify(block.node)).not.toContain("anchorId");
    }
  });

  it("strips the anchorId attribute recursively from nested block content", () => {
    const html = '<ul id="list-1"><li><p id="item-para">Nested paragraph.</p></li></ul>';

    const { blocks } = htmlToDocument(html);
    const list = blocksOfType(blocks, "bulletList")[0] as {
      anchorId: string | null;
      node: DocumentNodeJSON;
    };

    expect(list.anchorId).toBe("list-1");

    const nestedParagraph = findDescendant(list.node, "paragraph")!;
    expect(nestedParagraph.attrs ?? {}).not.toHaveProperty("anchorId");
    expect(JSON.stringify(list.node)).not.toContain("anchorId");
  });

  // #516: section fragment ids authored on a structural wrapper (`<div class="sect1" id>`,
  // `<section id>`) must hoist onto the section's leading block so the anchor survives ingestion.
  it("hoists a <div> section-wrapper id onto the section's leading block (its heading)", () => {
    const html =
      '<div class="sect1" id="sec_x"><h1>Reliability</h1><p>Body of the section.</p></div>';

    const { blocks } = htmlToDocument(html);
    const [heading, body] = blocks as ReadonlyArray<{
      anchorId: string | null;
      node: DocumentNodeJSON;
      type: string;
    }>;

    expect(heading!.type).toBe("heading");
    expect(heading!.anchorId).toBe("sec_x");
    // Only the leading block adopts it; the following paragraph stays unanchored.
    expect(body!.anchorId).toBeNull();
    // A pure id move: the rendered text is unchanged (plaintext == textContent contract).
    expect(textOf(heading!.node)).toBe("Reliability");
  });

  it("hoists a <section> wrapper id onto its leading block", () => {
    const { blocks } = htmlToDocument('<section id="sec_y"><h2>Scalability</h2></section>');
    const [heading] = blocks as ReadonlyArray<{ anchorId: string | null }>;

    expect(heading!.anchorId).toBe("sec_y");
  });

  it("never overwrites a block's own id; the wrapper id falls to the next id-less block", () => {
    const html = '<div id="wrap"><h1 id="own">Heading</h1><p>Following paragraph.</p></div>';

    const { blocks } = htmlToDocument(html);
    const [heading, paragraph] = blocks as ReadonlyArray<{ anchorId: string | null }>;

    // The innermost, more specific id wins on the heading; "wrap" adopts the next block without one.
    expect(heading!.anchorId).toBe("own");
    expect(paragraph!.anchorId).toBe("wrap");
  });

  it("maps a nested inner wrapper and its outer wrapper to different leading blocks", () => {
    // Innermost wins its own leading block (the heading); the outer wrapper adopts the next id-less
    // block, so the two wrapper ids never collapse onto the same block.
    const html =
      '<div id="outer"><div class="sect1" id="inner"><h1>Section</h1><p>Body.</p></div></div>';

    const { blocks } = htmlToDocument(html);
    const [heading, body] = blocks as ReadonlyArray<{ anchorId: string | null; type: string }>;

    expect(heading!.type).toBe("heading");
    expect(heading!.anchorId).toBe("inner");
    expect(body!.anchorId).toBe("outer");
  });

  it("contributes no anchor for a wrapper enclosing no block-level descendant (no crash)", () => {
    const { blocks, evidence } = htmlToDocument(
      '<section id="empty"></section><p id="after">After.</p>'
    );
    const paragraph = blocksOfType(blocks, "paragraph")[0] as { anchorId: string | null };

    // The empty wrapper drops silently (it addresses nothing); the real block keeps its own id, and
    // nothing throws. An EMPTY anchored wrapper is not a content loss, so it emits no evidence (#523).
    expect(paragraph.anchorId).toBe("after");
    expect(evidence).toHaveLength(0);
  });

  it("does not hoist an id off an inline tolerated element onto its block", () => {
    // A `<span id>` is an inline anchor, not a section wrapper: it must not jump to the paragraph.
    const { blocks } = htmlToDocument('<p>text <span id="inline">x</span> more</p>');
    const [paragraph] = blocks as ReadonlyArray<{ anchorId: string | null }>;

    expect(paragraph!.anchorId).toBeNull();
  });

  it("leaves a callout's own id intact rather than treating the callout as a wrapper", () => {
    // A `<div data-type="note" id>` is itself a block (it captures its own id); it is not a hoistable
    // structural wrapper.
    const { blocks } = htmlToDocument('<div data-type="note" id="cal"><p>Heads up.</p></div>');
    const callout = blocksOfType(blocks, "callout")[0] as { anchorId: string | null };

    expect(callout.anchorId).toBe("cal");
  });

  it("flags an unknown block element with evidence and preserves its neighbors", () => {
    const html =
      "<p>Before the widget.</p>" +
      '<video src="clip.mp4" controls>fallback</video>' +
      "<p>After the widget.</p>";

    const { blocks, doc, evidence } = htmlToDocument(html);

    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "unknown", "paragraph"]);

    const unknown = blocksOfType(blocks, "unknown")[0]!;

    expect(unknown.node.attrs?.["tag"]).toBe("video");
    expect(unknown.node.attrs?.["html"]).toContain("<video");
    expect(unknown.node.attrs?.["html"]).toContain("clip.mp4");

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("video");
    expect(evidence[0]!.attributes["src"]).toBe("clip.mp4");
    expect(evidence[0]!.path).toBe("body>video");
    expect(evidence[0]!.adjacentText).toContain("Before the widget.");

    expect(textOf(blocks[0]!.node)).toBe("Before the widget.");
    expect(textOf(blocks[2]!.node)).toBe("After the widget.");
    expect(isValidDocument(doc)).toBe(true);
  });

  it("builds an nth-of-type path and empty adjacent text for a nested only-child unknown", () => {
    const html =
      '<div data-type="sidebar"><p>Sidebar copy.</p></div>' + "<div><canvas></canvas></div>";

    const { blocks, evidence } = htmlToDocument(html);

    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "unknown"]);
    expect(textOf(blocks[0]!.node)).toBe("Sidebar copy.");

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("canvas");
    expect(evidence[0]!.path).toBe("body>div:nth-of-type(2)>canvas");
    expect(evidence[0]!.adjacentText).toBe("");
  });

  it("preserves tolerated inline formatting as plain text (nothing dropped)", () => {
    const html = "<p>Plain <em>emphasized</em> and <code>inline code</code> end.</p>";

    const { blocks } = htmlToDocument(html);
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(textOf(paragraph.node)).toBe("Plain emphasized and inline code end.");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \n  "]
  ])("yields a valid empty paragraph with no evidence for %s input", (_label, html) => {
    const { blocks, doc, evidence } = htmlToDocument(html);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("paragraph");
    expect(blocks[0]!.node.content).toBeUndefined();
    expect(blocks[0]!.id).toEqual(expect.any(String));
    expect(evidence).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
    expect(() => parseDocument(doc)).not.toThrow();
  });

  it("keeps a code listing with inline callout markers as one cohesive code block (#336)", () => {
    const listing =
      '<pre data-type="programlisting" data-code-language="ruby">' +
      'counts = Hash.new(0) <a href="#co1"><img src="callouts/1.png" alt="1"/></a>\n' +
      "\n" +
      "File.open('/var/log/nginx/access.log') do |file|\n" +
      "  file.each do |line|\n" +
      '    url = line.split[6] <a href="#co2"><img src="callouts/2.png" alt="2"/></a>\n' +
      '    counts[url] += 1 <a href="#co3"><img src="callouts/3.png" alt="3"/></a>\n' +
      "  end\n" +
      "end\n" +
      "</pre>";

    const { blocks, doc, evidence } = htmlToDocument(listing);
    const codeBlocks = blocksOfType(blocks, "codeBlock");

    // Exactly one code block; nothing shattered into figure/image/unknown.
    expect(codeBlocks).toHaveLength(1);
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(blocks.every((block) => findDescendant(block.node, "image") === undefined)).toBe(true);

    // Every source line, its indentation, and its newlines survive verbatim, with each marker inline
    // at its original position as a circled-number glyph (none dropped, none merged).
    expect(textOf(codeBlocks[0]!.node)).toBe(
      "counts = Hash.new(0) ❶\n" +
        "\n" +
        "File.open('/var/log/nginx/access.log') do |file|\n" +
        "  file.each do |line|\n" +
        "    url = line.split[6] ❷\n" +
        "    counts[url] += 1 ❸\n" +
        "  end\n" +
        "end\n"
    );
    expect(codeBlocks[0]!.node.attrs?.["language"]).toBe("ruby");
    expect(evidence).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
  });

  it("keeps a following calloutlist as an orderedList and leaves marker-free code untouched", () => {
    const html =
      "<pre>plain code, no markers ❶ already text</pre>" +
      '<ol class="calloutlist"><li>First explanation</li><li>Second explanation</li></ol>';

    const { blocks, evidence } = htmlToDocument(html);
    const codeBlocks = blocksOfType(blocks, "codeBlock");
    const orderedLists = blocksOfType(blocks, "orderedList");

    // A pure-text listing (including a pre-existing Unicode glyph) is unchanged.
    expect(codeBlocks).toHaveLength(1);
    expect(textOf(codeBlocks[0]!.node)).toBe("plain code, no markers ❶ already text");
    expect(orderedLists).toHaveLength(1);
    expect(orderedLists[0]!.node.content).toHaveLength(2);
    expect(evidence).toHaveLength(0);
  });

  it("maps marker numbers to glyphs by alt, wrapper, standalone img, span, and beyond-range", () => {
    const html =
      "<pre>" +
      'a <a href="#co1"><img src="callouts/1.png" alt="1"/></a> ' + // wrapper, href#co
      '<a><img alt="5"/></a> ' + // wrapper, no href/class → inner callout img
      '<img src="callouts/9.png" alt="11"/> ' + // standalone img, 11–20 glyph
      '<a class="co">21</a> ' + // anchor by class, beyond glyph range
      '<span class="co">★</span> ' + // span, non-numeric label
      '<span class="co">❷</span>' + // span, pre-existing glyph kept
      "</pre>";

    const { blocks, evidence } = htmlToDocument(html);
    const codeBlocks = blocksOfType(blocks, "codeBlock");

    expect(codeBlocks).toHaveLength(1);
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
    expect(textOf(codeBlocks[0]!.node)).toBe("a ❶ ❺ ⓫ (21) (★) ❷");
    expect(evidence).toHaveLength(0);
  });

  it("renders a callout with a non-positive number parenthesized via its label", () => {
    const html = '<pre>x <img src="callouts/0.png" alt="0"/></pre>';

    const { blocks } = htmlToDocument(html);
    const codeBlocks = blocksOfType(blocks, "codeBlock");

    expect(codeBlocks).toHaveLength(1);
    expect(textOf(codeBlocks[0]!.node)).toBe("x (0)");
  });

  it("recovers an unreadable callout marker by document order and records fail-loud evidence", () => {
    const html = '<pre>code line <a href="#co1"><img src="callouts/1.png" alt=""/></a></pre>';

    const { blocks, evidence } = htmlToDocument(html);
    const codeBlocks = blocksOfType(blocks, "codeBlock");

    // The block stays cohesive with an order-derived glyph — never shattered, never dropped.
    expect(codeBlocks).toHaveLength(1);
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
    expect(textOf(codeBlocks[0]!.node)).toBe("code line ❶");
    // …but the unreadable marker is surfaced as evidence, preserving the fail-loud invariant.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("a");
    expect(evidence[0]!.path).toBe("body>pre>a");
    expect(evidence[0]!.attributes["href"]).toBe("#co1");
  });

  it("does not treat a non-callout image inside a pre as a marker (scoped normalization)", () => {
    const html =
      "<pre>text " +
      '<a href="notes.html">ref</a> and ' +
      '<a href="pages.html"><img src="pic.png" alt="diagram"/></a></pre>';

    const { blocks, evidence } = htmlToDocument(html);

    // A genuine (non-callout) image keeps its legacy handling: it is not rewritten to a glyph, so no
    // evidence is emitted for it and its image survives as an image node; the plain link is untouched.
    expect(evidence).toHaveLength(0);
    expect(blocks.some((block) => findDescendant(block.node, "image") !== undefined)).toBe(true);
    const codeBlocks = blocksOfType(blocks, "codeBlock");
    expect(textOf(codeBlocks[0]!.node)).not.toContain("❶");
  });
});

describe("htmlToDocument CJK inter-character spacing (#340)", () => {
  it("removes stray ASCII spaces between Han characters", () => {
    const { blocks, evidence } = htmlToDocument("<p>以合六 爻之变</p>");

    // Scan-noise spacing is stripped, and it is not a fidelity violation (no evidence).
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("以合六爻之变");
    expect(evidence).toHaveLength(0);
  });

  it("normalizes a bare-body chapter to zero inter-CJK spaces, preserving heading and paragraph", () => {
    const html = "<h1>序</h1><p>以合六 爻之变。然后 两仪四象，按周公制礼而有 九数。</p>";

    const { blocks } = htmlToDocument(html);
    const headings = blocksOfType(blocks, "heading");
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(headings).toHaveLength(1);
    expect(textOf(headings[0]!.node)).toBe("序");
    expect(textOf(paragraph.node)).toBe("以合六爻之变。然后两仪四象，按周公制礼而有九数。");
    // No ASCII space remains flanked by Han characters.
    expect(textOf(paragraph.node)).not.toMatch(/[\u4e00-\u9fff] +[\u4e00-\u9fff]/);
  });

  it("collapses a run of multiple ASCII spaces between CJK entirely", () => {
    const { blocks } = htmlToDocument("<p>六  爻</p>");

    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("六爻");
  });

  it("preserves a space between a Han character and a Latin letter or digit", () => {
    const { blocks } = htmlToDocument("<p>公元 250 年</p>");

    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("公元 250 年");
  });

  it("removes a space flanked by CJK punctuation but not the ideographic space U+3000", () => {
    const { blocks } = htmlToDocument("<p>见《 九章》六　爻</p>");

    // The ASCII space after 《 is stripped (《 is CJK-class); the U+3000 between 六 and 爻 is kept.
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("见《九章》六　爻");
  });

  it("preserves whitespace inside a code block verbatim", () => {
    const { blocks } = htmlToDocument("<pre>中文 空格 保留</pre>");

    expect(textOf(blocksOfType(blocks, "codeBlock")[0]!.node)).toBe("中文 空格 保留");
  });

  it("preserves whitespace inside inline code while normalizing surrounding prose", () => {
    const { blocks } = htmlToDocument("<p>看 <code>字 元</code> 排</p>");

    // <code> is skipped, so its internal CJK space survives verbatim.
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toContain("字 元");
  });

  it("normalizes text across nested inline elements without joining separate text nodes", () => {
    const { blocks } = htmlToDocument("<p>中文<em>斜 体</em>混 排</p>");

    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("中文斜体混排");
  });

  it("strips inter-CJK spaces that straddle an inline element boundary (#358)", () => {
    const { blocks, evidence } = htmlToDocument("<p>使用 <b>传硕计划</b> 中的公版书</p>");

    // Both boundary spaces around the <b>-wrapped proper noun are removed (the #340 per-node pass
    // could not see the Han across the inline element).
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("使用传硕计划中的公版书");
    expect(evidence).toHaveLength(0);
  });

  it.each([
    ["i", "<p>见 <i>周髀</i> 之术</p>", "见周髀之术"],
    ["em", "<p>见 <em>周髀</em> 之术</p>", "见周髀之术"],
    ["strong", "<p>见 <strong>周髀</strong> 之术</p>", "见周髀之术"],
    ["a", '<p>见 <a href="#x">周髀</a> 之术</p>', "见周髀之术"],
    ["span", '<p>见 <span class="k">周髀</span> 之术</p>', "见周髀之术"],
    ["sup", "<p>见 <sup>周髀</sup> 之术</p>", "见周髀之术"]
  ])("strips inter-CJK spaces across an inline <%s> boundary", (_tag, html, expected) => {
    const { blocks } = htmlToDocument(html);

    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe(expected);
  });

  it("preserves a space between a Han character and Latin/digits across an inline boundary", () => {
    const { blocks } = htmlToDocument('<p>见 <a href="#f">Figure 1</a> 处</p>');

    // The <a> content is Latin/digits, so neither boundary space is inter-CJK — both are kept.
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("见 Figure 1 处");
  });

  it("does not touch the ideographic space U+3000 across an inline boundary", () => {
    const { blocks } = htmlToDocument("<p>甲　<b>乙</b>丙</p>");

    // U+3000 is not ASCII whitespace, so the inline-boundary pass leaves it, like #340.
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("甲　乙丙");
  });

  it("keeps whitespace inside inline <code> and never joins across it", () => {
    const { blocks } = htmlToDocument("<p>甲 <code>x y</code> 乙</p>");

    // <code> ends the inline run and its spacing is significant, so the code's internal space and the
    // spaces flanking it are all preserved.
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toContain("x y");
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toContain("甲 ");
    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toContain(" 乙");
  });

  it("keeps a <pre> block's inter-CJK spacing verbatim", () => {
    const { blocks } = htmlToDocument("<pre>中 文 保留</pre>");

    expect(textOf(blocksOfType(blocks, "codeBlock")[0]!.node)).toBe("中 文 保留");
  });

  it("never joins inter-CJK spacing across a block boundary", () => {
    const { blocks } = htmlToDocument("<p>甲 </p><p> 乙</p>");

    // Two separate paragraphs: the trailing/leading spaces are their own (ProseMirror trims them), and
    // the Han of one block is never joined to the next.
    expect(blocksOfType(blocks, "paragraph").map((block) => textOf(block.node))).toEqual([
      "甲",
      "乙"
    ]);
  });

  it("treats an interleaved HTML comment as invisible, joining the Han around it", () => {
    const { blocks } = htmlToDocument("<p>甲 <b>乙</b><!-- note -->丙</p>");

    expect(textOf(blocksOfType(blocks, "paragraph")[0]!.node)).toBe("甲乙丙");
  });
});

describe("htmlToDocument inline tolerance (#357)", () => {
  it("keeps inline <tt> in one paragraph, never shattering prose into unknown blocks", () => {
    const { blocks, evidence } = htmlToDocument(
      '<p>Run <tt>ls -l</tt> then <tt class="cmd">grep foo</tt>.</p>'
    );
    const paragraphs = blocksOfType(blocks, "paragraph");

    // One sentence stays one paragraph, with the <tt> text preserved inline as plain text.
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("Run ls -l then grep foo.");
    // No shattering: no unknown block and no fail-loud evidence for a tolerated inline element.
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it.each([
    ["big", "<p>a <big>B</big> c</p>", "a B c"],
    ["font", '<p>a <font color="red">B</font> c</p>', "a B c"],
    ["strike", "<p>a <strike>B</strike> c</p>", "a B c"],
    ["acronym", '<p>a <acronym title="x">B</acronym> c</p>', "a B c"],
    ["dfn", "<p>a <dfn>B</dfn> c</p>", "a B c"],
    ["bdi", "<p>a <bdi>B</bdi> c</p>", "a B c"],
    ["bdo", '<p>a <bdo dir="rtl">B</bdo> c</p>', "a B c"],
    // A CJK ruby annotation keeps its base + reading text inline; the paragraph is not split.
    ["ruby", "<p>a <ruby>漢<rp>(</rp><rt>hàn</rt><rp>)</rp></ruby> c</p>", "a 漢(hàn) c"]
  ])("tolerates inline <%s> without splitting the paragraph", (_tag, html, expected) => {
    const { blocks, evidence } = htmlToDocument(html);
    const paragraphs = blocksOfType(blocks, "paragraph");

    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe(expected);
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it("tolerates <hr> as a silent drop — no unknown block and no fail-loud evidence", () => {
    const { blocks, evidence } = htmlToDocument("<p>Before.</p><hr/><p>After.</p>");

    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    // The thematic break carries no text, so it simply drops; the surrounding prose is intact.
    expect(blocksOfType(blocks, "paragraph").map((block) => textOf(block.node))).toEqual([
      "Before.",
      "After."
    ]);
  });

  it("still fails loud for a genuinely unknown block element (regression guard)", () => {
    const { blocks, evidence } = htmlToDocument('<p>Before.</p><video src="clip.mp4"></video>');

    // An unmodeled block element (not inline) is still wrapped as unknown with evidence — inline
    // tolerance did not weaken the block-level fail-loud invariant.
    expect(blocksOfType(blocks, "unknown")).toHaveLength(1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("video");
  });
});

describe("htmlToDocument MathML tolerance (#361)", () => {
  it("keeps inline <math> in one paragraph, showing its symbols as inline text", () => {
    const { blocks, evidence } = htmlToDocument(
      "<p>The heap holds <math><mi>n</mi></math> objects at time <math><mi>t</mi></math>.</p>"
    );
    const paragraphs = blocksOfType(blocks, "paragraph");

    // The sentence stays one paragraph; each formula's symbols (n, t) appear inline, not dropped.
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("The heap holds n objects at time t.");
    // Handled, not dropped: no unknown block and no fail-loud evidence for <math> or its children.
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it("renders display/block <math> as readable inline text, not a shattered opaque block", () => {
    const { blocks, evidence } = htmlToDocument(
      '<p><math display="block"><mrow><mi>x</mi><mo>=</mo><mn>2</mn></mrow></math></p>'
    );
    const paragraphs = blocksOfType(blocks, "paragraph");

    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("x=2");
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it("does not descend into MathML children, so nested elements never leak as unknown or raw markup", () => {
    const { blocks, doc, evidence } = htmlToDocument(
      "<p>Let <math><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><mfrac><mi>b</mi><mi>c</mi></mfrac></math> hold.</p>"
    );
    const paragraphs = blocksOfType(blocks, "paragraph");

    // The whole MathML subtree collapses to its concatenated symbol text; msup/mfrac/mi/mn/mo never
    // surface as unknown blocks, evidence, or literal `<math>…</math>` markup.
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("Let a2+bc hold.");
    expect(textOf(paragraphs[0]!.node)).not.toContain("<math");
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
  });

  it("still fails loud for a genuinely unknown block element alongside math (regression guard)", () => {
    const { blocks, evidence } = htmlToDocument(
      '<p>Value <math><mi>k</mi></math>.</p><video src="clip.mp4"></video>'
    );

    // Tolerating <math> did not weaken the block-level fail-loud invariant: <video> is still flagged.
    expect(blocksOfType(blocks, "unknown")).toHaveLength(1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("video");
  });
});

describe("htmlToDocument SVG image normalization", () => {
  function imageIn(
    blocks: ReadonlyArray<{ node: DocumentNodeJSON }>
  ): DocumentNodeJSON | undefined {
    return blocks
      .map((block) => findDescendant(block.node, "image"))
      .find((node) => node !== undefined);
  }

  it("unwraps an <svg><image href> raster wrapper into a figure image with no evidence", () => {
    const { blocks, doc, evidence } = htmlToDocument(
      '<svg viewBox="0 0 10 10"><image href="diagram.png" width="10" height="10"/></svg>'
    );

    // The SVG-wrapped raster becomes a real image node, and <svg> never reaches the fail-loud walk.
    expect(evidence).toHaveLength(0);
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
    const image = imageIn(blocks);
    expect(image).toBeDefined();
    expect(image!.attrs?.["src"]).toBe("diagram.png");
    expect(isValidDocument(doc)).toBe(true);
  });

  it("reads the SVG 1.1 xlink:href and carries the image alt", () => {
    const { blocks, evidence } = htmlToDocument(
      '<svg><image xlink:href="fig.png" alt="A sequence diagram"/></svg>'
    );

    expect(evidence).toHaveLength(0);
    const image = imageIn(blocks)!;
    expect(image.attrs?.["src"]).toBe("fig.png");
    expect(image.attrs?.["alt"]).toBe("A sequence diagram");
  });

  it("falls back to the <svg> aria-label when the <image> carries no alt", () => {
    const { blocks } = htmlToDocument(
      '<svg aria-label="Cluster topology"><image href="fig.png"/></svg>'
    );
    const image = imageIn(blocks)!;

    expect(image.attrs?.["alt"]).toBe("Cluster topology");
  });

  it("leaves a pure-vector <svg> (no <image>) to the fail-loud walk", () => {
    const { evidence } = htmlToDocument('<p>Before.</p><svg><rect width="10" height="10"/></svg>');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("svg");
  });

  it("leaves an <svg> whose <image> has no usable href to the fail-loud walk", () => {
    const { evidence } = htmlToDocument('<svg><image width="10"/></svg>');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("svg");
  });
});

describe("htmlToDocument inline-image loss is loud (#523)", () => {
  it("records evidence for a mid-paragraph <img> and keeps the prose as one intact paragraph", () => {
    const { blocks, doc, evidence } = htmlToDocument(
      '<p>See the diagram <img src="d.png" alt="A dot"/> here.</p>'
    );

    // The inline image has no schema home, so it is dropped LOUDLY: one evidence record naming the
    // img, its path, and the surrounding prose — never a silent shatter into fragments + a caption.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("img");
    expect(evidence[0]!.path).toBe("body>p>img");
    expect(evidence[0]!.attributes["src"]).toBe("d.png");
    expect(evidence[0]!.adjacentText).toContain("See the diagram");

    // The prose survives intact as a single paragraph (no shattered fragments, no spurious figure).
    const paragraphs = blocksOfType(blocks, "paragraph");
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("See the diagram here.");
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
    expect(isValidDocument(doc)).toBe(true);
  });

  it("makes an inline <svg><image> in flowing text loud too (normalized then caught)", () => {
    const { blocks, evidence } = htmlToDocument(
      '<p>See <svg><image href="d.png"/></svg> here.</p>'
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("img");
    const paragraphs = blocksOfType(blocks, "paragraph");
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!.node)).toBe("See here.");
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
  });

  it("records evidence for an inline image mid-figcaption, preserving the caption text", () => {
    const { blocks, evidence } = htmlToDocument(
      '<figure><img src="main.png" alt="main"/><figcaption>Panel <img src="inset.png"/> inset</figcaption></figure>'
    );

    // The figure's own image is fine; the stray inline image inside the caption is the loud loss.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("img");
    expect(evidence[0]!.path).toContain("figcaption");
    expect(textOf(blocksOfType(blocks, "figure")[0]!.node)).toBe("Panel inset");
  });

  it("leaves a standalone block image untouched — a lone <img> still becomes a figure", () => {
    const { blocks, evidence } = htmlToDocument(
      '<p>Before.</p><img src="b.png" alt="B"/><p>After.</p>'
    );

    // A body-level image is a standalone figure, not inline loss: no evidence, figure preserved.
    expect(evidence).toHaveLength(0);
    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
    expect(blocksOfType(blocks, "paragraph").map((block) => textOf(block.node))).toEqual([
      "Before.",
      "After."
    ]);
  });

  it("leaves an image that is the sole content of its paragraph as a figure (not inline loss)", () => {
    const { blocks, evidence } = htmlToDocument('<p><img src="p.png" alt="d"/></p>');

    expect(evidence).toHaveLength(0);
    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
  });

  it("records evidence for a SOLE image inside a figcaption (a child-only container it mangles)", () => {
    // A figcaption is nested in its figure and cannot host a standalone figure: a sole image there is
    // promoted to a spurious sibling figure, emptying the caption. Make it loud and keep one figure.
    const { blocks, evidence } = htmlToDocument(
      '<figure><img src="main.png" alt="main"/><figcaption><img src="cap.png"/></figcaption></figure>'
    );

    const imgEvidence = evidence.filter((record) => record.tag === "img");
    expect(imgEvidence).toHaveLength(1);
    expect(imgEvidence[0]!.attributes["src"]).toBe("cap.png");
    expect(imgEvidence[0]!.path).toContain("figcaption");
    // Exactly one figure (the main image); the stray caption image did not become a second figure.
    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
  });

  it("records evidence for a SOLE image inside a definition term (a child-only container)", () => {
    const { blocks, evidence } = htmlToDocument(
      '<dl><dt><img src="term.png"/></dt><dd>desc</dd></dl>'
    );

    const imgEvidence = evidence.filter((record) => record.tag === "img");
    expect(imgEvidence).toHaveLength(1);
    expect(imgEvidence[0]!.attributes["src"]).toBe("term.png");
    // The definition list is still produced; the mangled term image is not silently promoted.
    expect(blocksOfType(blocks, "definitionList")).toHaveLength(1);
    expect(blocksOfType(blocks, "figure")).toHaveLength(0);
  });

  it("leaves a sole image in a heading as a standalone figure (not a child-only container)", () => {
    const { blocks, evidence } = htmlToDocument('<h1><img src="banner.png" alt="b"/></h1>');

    // A heading is standalone-capable like <p>: a sole image lifts into a clean figure, no loss.
    expect(evidence).toHaveLength(0);
    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
  });

  it("leaves an <img> inside a code listing to callout normalization, not inline-image loss", () => {
    const { blocks, evidence } = htmlToDocument(
      '<pre>text <a href="pages.html"><img src="pic.png" alt="diagram"/></a></pre>'
    );

    // Images inside <pre>/<code> keep their existing handling; the inline-image pass skips them.
    expect(evidence).toHaveLength(0);
    expect(blocks.some((block) => findDescendant(block.node, "image") !== undefined)).toBe(true);
  });
});

describe("htmlToDocument wrapper-metadata loss is loud (#523)", () => {
  it("records evidence when an anchored wrapper has only inline content (no block to carry the id)", () => {
    const { blocks, evidence } = htmlToDocument(
      '<div id="w"><span>inline only</span></div><p id="after">After.</p>'
    );

    // The div's id can never reach the anonymous paragraph its inline content collapses into, so the
    // lost anchor is made loud rather than silently discarded.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.tag).toBe("div");
    expect(evidence[0]!.path).toBe("body>div");
    expect(evidence[0]!.attributes["id"]).toBe("w");

    // The following real block keeps its own id; the inline content still becomes a paragraph.
    const paragraphs = blocks as ReadonlyArray<{ anchorId: string | null; node: DocumentNodeJSON }>;
    expect(textOf(paragraphs[0]!.node)).toBe("inline only");
    expect(paragraphs[0]!.anchorId).toBeNull();
    expect(paragraphs[1]!.anchorId).toBe("after");
  });

  it("records evidence for a co-anchored nesting whose outer id cannot reach any block", () => {
    // The inner wrapper hoists onto the heading; the outer wrapper's id then has no block to land on
    // (the only block already carries #inner, and a block holds a single anchor), so #outer would be
    // silently lost — make it loud instead. Regression guard: links to #outer must not vanish.
    const { blocks, evidence } = htmlToDocument(
      '<div id="outer"><div id="inner"><h1>Section</h1></div></div>'
    );

    const heading = blocks[0] as { anchorId: string | null; node: DocumentNodeJSON; type: string };
    expect(heading.type).toBe("heading");
    expect(heading.anchorId).toBe("inner");

    const outerEvidence = evidence.filter((record) => record.attributes["id"] === "outer");
    expect(outerEvidence).toHaveLength(1);
    expect(outerEvidence[0]!.tag).toBe("div");
    expect(outerEvidence[0]!.path).toBe("body>div");
  });
  it("records evidence when an anchored wrapper holds only a standalone image (figure loses its anchor)", () => {
    // `<div id="fig"><img/></div>`: the img becomes a figure block, but it is not a BLOCK_LEVEL_TAG and
    // carries no text, so the wrapper has no block target for #fig. The anchor cannot ride the
    // auto-wrapped figure, so it is made loud rather than dropped when the tolerated <div> is unwrapped.
    const { blocks, evidence } = htmlToDocument('<div id="fig"><img src="b.png" alt="B"/></div>');

    // The figure is still produced; only the wrapper's anchor is the loss.
    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
    const figEvidence = evidence.filter((record) => record.attributes["id"] === "fig");
    expect(figEvidence).toHaveLength(1);
    expect(figEvidence[0]!.tag).toBe("div");
    expect(figEvidence[0]!.path).toBe("body>div");
  });

  it("records evidence when an anchored wrapper holds only an <svg><image> figure", () => {
    const { blocks, evidence } = htmlToDocument(
      '<section id="diag"><svg><image href="d.png"/></svg></section>'
    );

    expect(blocksOfType(blocks, "figure")).toHaveLength(1);
    expect(evidence.filter((record) => record.attributes["id"] === "diag")).toHaveLength(1);
  });

  it("does not flag a wrapper whose only content is a decorative textless break", () => {
    // `<hr>` is a decorative silent-drop that yields no block; an anchored wrapper around only it
    // addresses nothing, so it drops quietly like an empty wrapper — no evidence.
    const { evidence } = htmlToDocument('<div id="deco"><hr/></div><p id="after">After.</p>');

    expect(evidence).toHaveLength(0);
  });

  it("records evidence when an anchored wrapper holds only a textless unknown construct", () => {
    // `<video>` is unknown (no schema rule): it has no block-level descendant, no text, and is not an
    // image/embed, but it is NOT tolerated — it produces its own fail-loud evidence. The wrapper still
    // addressed it, so #clip must not vanish silently when the tolerated <div> is unwrapped.
    const { evidence } = htmlToDocument('<div id="clip"><video src="clip.mp4"></video></div>');

    // The wrapper's own anchor is surfaced (distinct from the <video>'s unknown-element evidence).
    const clipEvidence = evidence.filter((record) => record.attributes["id"] === "clip");
    expect(clipEvidence).toHaveLength(1);
    expect(clipEvidence[0]!.tag).toBe("div");
    // …and the <video> still fails loud in its own right.
    expect(evidence.some((record) => record.tag === "video")).toBe(true);
  });

  it("does not flag a wrapper enclosing only empty tolerated elements (no content produced)", () => {
    // An empty nested structural wrapper / empty inline element yields no block and no evidence, so the
    // outer anchor addresses nothing — a quiet drop, not a loss.
    const { evidence } = htmlToDocument(
      '<div id="outer"><div><span></span></div></div><p id="after">After.</p>'
    );

    expect(evidence).toHaveLength(0);
  });
});

describe("htmlToDocument reference links (#368)", () => {
  // The `link` mark on a text node, if any: the marks array lives on the text node, not as a child
  // node, so the footnote-style `findDescendant` walk cannot reach it.
  function findLinkMark(node: DocumentNodeJSON): Record<string, unknown> | undefined {
    for (const mark of node.marks ?? []) {
      if (mark["type"] === "link") {
        return mark["attrs"] as Record<string, unknown>;
      }
    }

    for (const child of childrenOf(node)) {
      const found = findLinkMark(child);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  // The text node that carries the `link` mark, so its text (the anchor's linked run) can be asserted.
  function findLinkedText(node: DocumentNodeJSON): string | undefined {
    if ((node.marks ?? []).some((mark) => mark["type"] === "link")) {
      return node.text;
    }

    for (const child of childrenOf(node)) {
      const found = findLinkedText(child);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  it("preserves a cross-chapter xref as a link mark carrying its href parts", () => {
    const { blocks } = htmlToDocument(
      '<p>Go to <a data-type="xref" href="ch01.html#ch_introduction">Chapter 1</a>.</p>'
    );
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toEqual({
      anchor: "ch_introduction",
      inert: false,
      kind: "xref",
      refFile: "ch01.html",
      targetSourceFile: null
    });
    // The linked text stays in the inline run — no descended-text-with-lost-href, no paragraph shatter.
    expect(findLinkedText(paragraph.node)).toBe("Chapter 1");
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
  });

  it("preserves a same-chapter `#id` link with a null file part and the generic `href` kind", () => {
    const { blocks } = htmlToDocument('<p>See <a href="#sec_two">this section</a>.</p>');
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toEqual({
      anchor: "sec_two",
      inert: false,
      kind: "href",
      refFile: null,
      targetSourceFile: null
    });
  });

  it("preserves a same-work link with an empty fragment (`path#`) as an anchorless link", () => {
    const { blocks } = htmlToDocument('<p>Open <a href="ch02.html#">chapter two</a>.</p>');
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toEqual({
      anchor: null,
      inert: false,
      kind: "href",
      refFile: "ch02.html",
      targetSourceFile: null
    });
  });

  it("preserves a same-work link with a bare path (no fragment) as an anchorless link", () => {
    const { blocks } = htmlToDocument('<p>Open <a href="ch02.html">chapter two</a>.</p>');
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toEqual({
      anchor: null,
      inert: false,
      kind: "href",
      refFile: "ch02.html",
      targetSourceFile: null
    });
  });

  it.each([
    ["https scheme", '<a href="https://example.com/x">the site</a>', "the site"],
    ["mailto scheme", '<a href="mailto:a@example.com">email us</a>', "email us"],
    ["protocol-relative", '<a href="//cdn.example.com/x">a mirror</a>', "a mirror"]
  ])("flags an external %s link as inert with no target", (_name, anchorHtml, linkedText) => {
    const { blocks } = htmlToDocument(`<p>Visit ${anchorHtml}.</p>`);
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toEqual({
      anchor: null,
      inert: true,
      kind: "href",
      refFile: null,
      targetSourceFile: null
    });
    // Even an inert link keeps its text in flow, never dropped or shattered.
    expect(findLinkedText(paragraph.node)).toBe(linkedText);
  });

  it("skips a bare hrefless anchor, leaving its text in flow with no link mark", () => {
    const { blocks } = htmlToDocument(
      '<p>An <a name="top">anchor</a> and <a href="">empty</a>.</p>'
    );
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    expect(findLinkMark(paragraph.node)).toBeUndefined();
    expect(textOf(paragraph.node)).toBe("An anchor and empty.");
    expect(blocksOfType(blocks, "unknown")).toHaveLength(0);
  });

  it("keeps a[data-type=noteref] as the footnoteMarker atom, not a link mark", () => {
    const { blocks } = htmlToDocument(
      '<p>Note<a data-type="noteref" href="notes.xhtml#fn1">1</a>.</p>'
    );
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    // The noteref rule wins over the generic link rule: a footnoteMarker node, and no link mark.
    expect(findDescendant(paragraph.node, "footnoteMarker")).toBeDefined();
    expect(findLinkMark(paragraph.node)).toBeUndefined();
  });

  it("renders a CJK inline link text IN FLOW so no gap opens (mark, not atom — #340 guard)", () => {
    const { blocks } = htmlToDocument('<p>见<a href="#zhoubi">周髀</a>之术</p>');
    const paragraph = blocksOfType(blocks, "paragraph")[0]!;

    // A mark keeps `周髀` inside the paragraph's inline run, so the text is contiguous: `见周髀之术`.
    // An inline atom would pull it out and reopen the inter-character gap (`见之术`).
    expect(textOf(paragraph.node)).toBe("见周髀之术");
    expect(findLinkedText(paragraph.node)).toBe("周髀");
    expect(findLinkMark(paragraph.node)?.["anchor"]).toBe("zhoubi");
  });

  it("keeps a link inside a code block as plain text (codeBlock allows no marks)", () => {
    const { blocks } = htmlToDocument('<pre><code>see <a href="#x">ref</a> here</code></pre>');
    const code = blocksOfType(blocks, "codeBlock")[0]!;

    // The `<a>` text survives verbatim, but no mark is applied inside the mark-free code block.
    expect(textOf(code.node)).toBe("see ref here");
    expect(findLinkMark(code.node)).toBeUndefined();
  });
});
