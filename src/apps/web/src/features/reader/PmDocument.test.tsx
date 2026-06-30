// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PmBlock, PmDocument } from "./PmDocument";
import { assignNodeIds, type DocumentNodeJSON } from "@whetstone/document";

// A hand-built PM document that exercises every node type at least once with its attributes present:
// the six heading levels, prose, a footnote marker, a blockquote, a fenced code block, nesting lists,
// an ordered list, a table (header + cell), a figure (display-only image + caption), a definition
// list, callouts (kinds + numbered/symbolic markers), a footnote target, and the raw-HTML unknown
// fallback. Ids are stamped once (UUIDs are random per call) so the same object can be reused across
// renders and its top-level ids asserted deterministically.
const richDoc: DocumentNodeJSON = {
  content: [
    { attrs: { level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" },
    { attrs: { level: 2 }, content: [{ text: "Level two", type: "text" }], type: "heading" },
    { attrs: { level: 3 }, content: [{ text: "Level three", type: "text" }], type: "heading" },
    { attrs: { level: 4 }, content: [{ text: "Level four", type: "text" }], type: "heading" },
    { attrs: { level: 5 }, content: [{ text: "Level five", type: "text" }], type: "heading" },
    { attrs: { level: 6 }, content: [{ text: "Level six", type: "text" }], type: "heading" },
    {
      content: [
        { text: "Intro ", type: "text" },
        { attrs: { label: "1", noteKind: "footnote", refId: "fn1" }, type: "footnoteMarker" }
      ],
      type: "paragraph"
    },
    {
      content: [{ content: [{ text: "quote", type: "text" }], type: "paragraph" }],
      type: "blockquote"
    },
    {
      attrs: { language: "ts" },
      content: [{ text: "const x = 1;", type: "text" }],
      type: "codeBlock"
    },
    {
      content: [
        {
          content: [
            { content: [{ text: "a", type: "text" }], type: "paragraph" },
            {
              content: [
                {
                  content: [{ content: [{ text: "nested", type: "text" }], type: "paragraph" }],
                  type: "listItem"
                }
              ],
              type: "bulletList"
            }
          ],
          type: "listItem"
        }
      ],
      type: "bulletList"
    },
    {
      attrs: { start: 3 },
      content: [
        {
          content: [{ content: [{ text: "one", type: "text" }], type: "paragraph" }],
          type: "listItem"
        }
      ],
      type: "orderedList"
    },
    {
      content: [
        {
          content: [
            {
              attrs: { colspan: 2, rowspan: 1 },
              content: [{ content: [{ text: "H", type: "text" }], type: "paragraph" }],
              type: "tableHeader"
            }
          ],
          type: "tableRow"
        },
        {
          content: [
            {
              attrs: { colspan: 1, rowspan: 2 },
              content: [{ content: [{ text: "C", type: "text" }], type: "paragraph" }],
              type: "tableCell"
            }
          ],
          type: "tableRow"
        }
      ],
      type: "table"
    },
    {
      content: [
        { attrs: { alt: "A dot", src: "x" }, type: "image" },
        { content: [{ text: "The caption.", type: "text" }], type: "figureCaption" }
      ],
      type: "figure"
    },
    {
      content: [
        { content: [{ text: "term", type: "text" }], type: "definitionTerm" },
        {
          content: [{ content: [{ text: "desc", type: "text" }], type: "paragraph" }],
          type: "definitionDescription"
        }
      ],
      type: "definitionList"
    },
    {
      attrs: { kind: "note", marker: 1 },
      content: [{ content: [{ text: "callout", type: "text" }], type: "paragraph" }],
      type: "callout"
    },
    {
      attrs: { kind: "tip", marker: "★" },
      content: [{ content: [{ text: "tipline", type: "text" }], type: "paragraph" }],
      type: "callout"
    },
    {
      attrs: { label: "1", noteKind: "footnote", refId: "fn1" },
      content: [{ content: [{ text: "the note", type: "text" }], type: "paragraph" }],
      type: "footnoteTarget"
    },
    { attrs: { html: "<custom-el>raw</custom-el>", tag: "custom-el" }, type: "unknown" }
  ],
  type: "doc"
};

// A second document whose top-level blocks carry NO ids and whose nodes omit their optional
// attributes, exercising the addressless and attribute-absent branches the rich document does not.
const bareDoc: DocumentNodeJSON = {
  content: [
    {
      content: [
        { type: "text" },
        { attrs: { refId: "only-ref" }, type: "footnoteMarker" },
        { type: "footnoteMarker" }
      ],
      type: "paragraph"
    },
    { content: [{ text: "no lang", type: "text" }], type: "codeBlock" },
    {
      content: [{ content: [{ text: "x", type: "text" }], type: "listItem" }],
      type: "orderedList"
    },
    {
      attrs: { start: 1 },
      content: [{ content: [{ text: "y", type: "text" }], type: "listItem" }],
      type: "orderedList"
    },
    {
      content: [{ content: [{ text: "plain", type: "text" }], type: "paragraph" }],
      type: "callout"
    },
    {
      content: [{ content: [{ text: "bare note", type: "text" }], type: "paragraph" }],
      type: "footnoteTarget"
    },
    { content: [{ type: "image" }], type: "figure" },
    {
      content: [
        {
          content: [
            {
              content: [{ content: [{ text: "h", type: "text" }], type: "paragraph" }],
              type: "tableHeader"
            }
          ],
          type: "tableRow"
        },
        {
          content: [
            {
              content: [{ content: [{ text: "z", type: "text" }], type: "paragraph" }],
              type: "tableCell"
            }
          ],
          type: "tableRow"
        }
      ],
      type: "table"
    },
    { type: "unknown" }
  ],
  type: "doc"
};

const richDocWithIds = assignNodeIds(richDoc);

function renderDoc(doc: DocumentNodeJSON): HTMLElement {
  return render(<PmDocument document={doc} />).container;
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".pmDocument") as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("PmDocument node rendering", () => {
  it("renders the six heading levels as their semantic elements", () => {
    const container = renderDoc(richDocWithIds);

    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("h2")?.textContent).toBe("Level two");
    expect(container.querySelector("h3")?.textContent).toBe("Level three");
    expect(container.querySelector("h4")?.textContent).toBe("Level four");
    expect(container.querySelector("h5")?.textContent).toBe("Level five");
    expect(container.querySelector("h6")?.textContent).toBe("Level six");
  });

  it("renders prose, blockquote and a fenced code block with its language", () => {
    const container = renderDoc(richDocWithIds);

    expect(container.querySelector("blockquote")?.textContent).toBe("quote");

    const code = container.querySelector("pre > code");
    expect(code?.textContent).toBe("const x = 1;");
    expect(code?.getAttribute("data-language")).toBe("ts");
  });

  it("renders nested bullet lists and an ordered list with a start offset", () => {
    const container = renderDoc(richDocWithIds);

    const outerList = container.querySelector("ul");
    expect(within(outerList as HTMLElement).getByText("a")).toBeTruthy();
    // The nested list item lives inside a child <ul>, proving the list nesting is preserved.
    expect(container.querySelector("ul ul li")?.textContent).toBe("nested");

    const ordered = container.querySelector("ol");
    expect(ordered?.getAttribute("start")).toBe("3");
    expect(ordered?.querySelector("li")?.textContent).toBe("one");
  });

  it("renders a table with header and data cells, preserving spans", () => {
    const container = renderDoc(richDocWithIds);

    const header = container.querySelector("table th");
    expect(header?.textContent).toBe("H");
    expect(header?.getAttribute("colspan")).toBe("2");

    const cell = container.querySelector("table td");
    expect(cell?.textContent).toBe("C");
    expect(cell?.getAttribute("rowspan")).toBe("2");
  });

  it("renders a figure as a caption plus a non-fetching, display-only image placeholder", () => {
    const container = renderDoc(richDocWithIds);

    const figure = container.querySelector("figure");
    expect(figure?.querySelector("figcaption")?.textContent).toBe("The caption.");

    // No <img> is ever created (nothing is fetched in v0); the image is an inert placeholder that
    // still exposes its alt text.
    expect(container.querySelector("img")).toBeNull();
    const placeholder = figure?.querySelector("[data-pm-image]");
    expect(placeholder?.getAttribute("role")).toBe("img");
    expect(placeholder?.getAttribute("aria-label")).toBe("A dot");
  });

  it("renders a definition list with its terms and descriptions", () => {
    const container = renderDoc(richDocWithIds);

    expect(container.querySelector("dl dt")?.textContent).toBe("term");
    expect(container.querySelector("dl dd")?.textContent).toBe("desc");
  });

  it("renders callouts with their kind and marker", () => {
    const container = renderDoc(richDocWithIds);

    const note = container.querySelector('[data-callout-kind="note"]');
    expect(note?.classList.contains("readerCallout")).toBe(true);
    expect(within(note as HTMLElement).getByText("callout")).toBeTruthy();
    expect(within(note as HTMLElement).getByText("1")).toBeTruthy();

    const tip = container.querySelector('[data-callout-kind="tip"]');
    expect(within(tip as HTMLElement).getByText("★")).toBeTruthy();
    expect(within(tip as HTMLElement).getByText("tipline")).toBeTruthy();
  });

  it("renders a footnote marker inline and a footnote target block", () => {
    const container = renderDoc(richDocWithIds);

    const marker = container.querySelector("sup.readerNoteref");
    expect(marker?.textContent).toBe("1");
    expect(marker?.getAttribute("data-footnote-ref")).toBe("fn1");

    const target = container.querySelector('[data-footnote-id="fn1"]');
    expect(within(target as HTMLElement).getByText("the note")).toBeTruthy();
  });

  it("renders the unknown fallback as inert, escaped text — not a live element", () => {
    const container = renderDoc(richDocWithIds);

    const unknown = container.querySelector("pre[data-pm-unknown]");
    // The raw markup is shown verbatim as text...
    expect(unknown?.textContent).toBe("<custom-el>raw</custom-el>");
    // ...and is escaped, so its inner tag is never a live element anywhere in the tree.
    expect(container.querySelector("custom-el")).toBeNull();
    expect(unknown?.innerHTML).toContain("&lt;custom-el&gt;");
  });
});

describe("PmDocument addressable ids", () => {
  it("gives every top-level block a non-empty data-block-id equal to its node's stable id", () => {
    const container = renderDoc(richDocWithIds);
    const topLevel = Array.from(root(container).children) as HTMLElement[];

    const expectedIds = (richDocWithIds.content ?? []).map((node) => node.attrs?.["id"]);
    expect(topLevel).toHaveLength(expectedIds.length);

    topLevel.forEach((element, index) => {
      const id = element.getAttribute("data-block-id");
      expect(id).toBeTruthy();
      expect(id).toBe(expectedIds[index]);
    });
  });

  it("does not address nested (non-top-level) nodes", () => {
    const container = renderDoc(richDocWithIds);

    // The caption and the inner list item are nested; they carry no block address.
    expect(container.querySelector("figcaption")?.hasAttribute("data-block-id")).toBe(false);
    expect(container.querySelector("ul ul li")?.hasAttribute("data-block-id")).toBe(false);
  });

  it("omits data-block-id when a top-level block has no stable id", () => {
    const container = renderDoc(bareDoc);
    const topLevel = Array.from(root(container).children) as HTMLElement[];

    for (const element of topLevel) {
      expect(element.hasAttribute("data-block-id")).toBe(false);
    }
  });
});

describe("PmDocument attribute-absent and empty branches", () => {
  it("renders nodes that omit their optional attributes", () => {
    const container = renderDoc(bareDoc);

    // codeBlock without a language: no data-language attribute.
    expect(container.querySelector("pre > code")?.hasAttribute("data-language")).toBe(false);

    // orderedList with start=1 or no start: the start attribute is left at the HTML default.
    for (const ordered of Array.from(container.querySelectorAll("ol"))) {
      expect(ordered.hasAttribute("start")).toBe(false);
    }

    // callout without a kind: no kind class modifier and no data-callout-kind.
    const callout = container.querySelector(".readerCallout");
    expect(callout?.getAttribute("class")).toBe("readerCallout");
    expect(callout?.hasAttribute("data-callout-kind")).toBe(false);
    expect(callout?.querySelector(".readerCalloutMarker")).toBeNull();

    // footnoteTarget without a label/refId.
    const target = container.querySelector(".readerFootnoteTarget");
    expect(target?.hasAttribute("data-footnote-id")).toBe(false);
    expect(target?.querySelector(".readerFootnoteLabel")).toBeNull();

    // image without alt: an empty accessible label, still no fetched <img>.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-pm-image]")?.getAttribute("aria-label")).toBe("");

    // table cell without spans.
    const cell = container.querySelector("td");
    expect(cell?.hasAttribute("colspan")).toBe(false);
    expect(cell?.hasAttribute("rowspan")).toBe(false);

    // unknown without preserved html renders an empty surface.
    expect(container.querySelector("pre[data-pm-unknown]")?.textContent).toBe("");
  });

  it("renders footnote markers that fall back through label, refId, then empty", () => {
    const container = renderDoc(bareDoc);
    const markers = Array.from(container.querySelectorAll("sup.readerNoteref"));

    // refId-only marker shows the refId and tags it.
    expect(markers[0]?.textContent).toBe("only-ref");
    expect(markers[0]?.getAttribute("data-footnote-ref")).toBe("only-ref");

    // marker with neither label nor refId renders empty and is untagged.
    expect(markers[1]?.textContent).toBe("");
    expect(markers[1]?.hasAttribute("data-footnote-ref")).toBe(false);
  });

  it("renders a text node with no text as nothing", () => {
    const container = renderDoc(bareDoc);
    const paragraph = root(container).querySelector("p") as HTMLElement;

    // The empty text node contributes no text; only the markers (also empty/short) are present.
    expect(paragraph.textContent).toBe("only-ref");
  });
});

describe("PmDocument theme-agnostic structure", () => {
  it("produces the same DOM regardless of the active Day/Night theme", () => {
    document.documentElement.dataset["theme"] = "day";
    const dayHtml = root(renderDoc(richDocWithIds)).innerHTML;
    cleanup();

    document.documentElement.dataset["theme"] = "night";
    const nightHtml = root(renderDoc(richDocWithIds)).innerHTML;

    // Day/Night is purely CSS variables on an ancestor; the rendered markup never branches on theme.
    expect(nightHtml).toBe(dayHtml);
  });
});

describe("PmBlock single-node rendering", () => {
  it("renders one block node directly, without the doc wrapper", () => {
    const node = {
      attrs: { id: "blk-1" },
      content: [{ text: "Just a paragraph.", type: "text" }],
      type: "paragraph"
    } as unknown as DocumentNodeJSON;

    const { container } = render(<PmBlock node={node} />);
    const paragraph = container.querySelector("p");

    expect(paragraph?.textContent).toBe("Just a paragraph.");
    // No `.pmDocument` doc root and no inline addressable id: the live reader wraps each block in its
    // own element and stamps `data-block-id` there (a per-block render has no `doc` parent).
    expect(container.querySelector(".pmDocument")).toBeNull();
    expect(paragraph?.getAttribute("data-block-id")).toBeNull();
  });

  it("renders a heading block at its level", () => {
    const node = {
      attrs: { id: "blk-h", level: 3 },
      content: [{ text: "Section", type: "text" }],
      type: "heading"
    } as unknown as DocumentNodeJSON;

    const { container } = render(<PmBlock node={node} />);

    expect(container.querySelector("h3")?.textContent).toBe("Section");
  });

  it("renders an unknown block's raw markup as inert escaped text", () => {
    const node = {
      attrs: { html: "<script>alert(1)</script>", id: "blk-u" },
      type: "unknown"
    } as unknown as DocumentNodeJSON;

    const { container } = render(<PmBlock node={node} />);
    const pre = container.querySelector("pre.readerUnknown");

    expect(pre?.textContent).toBe("<script>alert(1)</script>");
    // The markup is shown as text, never parsed into a live element.
    expect(container.querySelector("script")).toBeNull();
  });
});
