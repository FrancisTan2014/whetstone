import { describe, expect, it } from "vitest";

import {
  assignNodeIds,
  type DocumentNodeJSON,
  createTextDocument,
  documentBlockHeading,
  documentMarkNames,
  documentNodeNames,
  documentReadableText,
  documentSchema,
  documentText,
  DocumentValidationError,
  isSafeDocumentLinkHref,
  isValidDocument,
  parseDocument,
  serializeDocument
} from "./index.js";

// A document that exercises every whetstone node type once: prose, nesting lists, a table, a figure,
// a definition list, a callout, a footnote marker + target, and the raw-HTML unknown fallback.
const richDoc: DocumentNodeJSON = {
  content: [
    { attrs: { level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" },
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
              attrs: { colspan: 1, rowspan: 1 },
              content: [{ content: [{ text: "H", type: "text" }], type: "paragraph" }],
              type: "tableHeader"
            }
          ],
          type: "tableRow"
        },
        {
          content: [
            {
              attrs: { colspan: 1, rowspan: 1 },
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
        { attrs: { alt: "y", src: "x" }, type: "image" },
        { content: [{ text: "cap", type: "text" }], type: "figureCaption" }
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
      attrs: { label: "1", noteKind: "footnote", refId: "fn1" },
      content: [{ content: [{ text: "the note", type: "text" }], type: "paragraph" }],
      type: "footnoteTarget"
    },
    { attrs: { html: "<custom-el>raw</custom-el>", tag: "custom-el" }, type: "unknown" }
  ],
  type: "doc"
};

function nodeTypesIn(json: DocumentNodeJSON, into: Set<string> = new Set()): Set<string> {
  into.add(json.type);
  for (const child of json.content ?? []) {
    nodeTypesIn(child, into);
  }
  return into;
}

function everyNodeWithoutText(
  json: DocumentNodeJSON,
  visit: (node: DocumentNodeJSON) => void
): void {
  if (json.type !== "text") {
    visit(json);
  }
  for (const child of json.content ?? []) {
    everyNodeWithoutText(child, visit);
  }
}

describe("document schema", () => {
  it("registers a node spec for every whetstone construct", () => {
    const expected = [
      "blockquote",
      "bulletList",
      "callout",
      "codeBlock",
      "definitionDescription",
      "definitionList",
      "definitionTerm",
      "doc",
      "figure",
      "figureCaption",
      "footnoteMarker",
      "footnoteTarget",
      "heading",
      "image",
      "listItem",
      "orderedList",
      "paragraph",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "text",
      "unknown"
    ];
    expect([...documentNodeNames].sort()).toEqual(expected);
    for (const name of expected) {
      expect(documentSchema.nodes[name]).toBeDefined();
    }
  });

  it("registers the shared inline formatting marks", () => {
    expect([...documentMarkNames]).toEqual(["bold", "italic", "code", "link"]);
    for (const name of documentMarkNames) {
      expect(documentSchema.marks[name]).toBeDefined();
    }
  });
});

describe("link mark round-trip (#368)", () => {
  // A paragraph whose inline run carries the `link` mark on the linked text only: a cross-chapter
  // xref, a same-file `#id` link, and an external inert link, each keeping its text in the run.
  const linkedDoc: DocumentNodeJSON = {
    content: [
      {
        content: [
          { text: "See ", type: "text" },
          {
            marks: [
              {
                attrs: {
                  anchor: "ch_introduction",
                  href: null,
                  inert: false,
                  kind: "xref",
                  refFile: "ch01.html",
                  targetSourceFile: "text/ch01.html"
                },
                type: "link"
              }
            ],
            text: "Chapter 1",
            type: "text"
          },
          { text: " and ", type: "text" },
          {
            marks: [
              {
                attrs: {
                  anchor: "sec",
                  href: null,
                  inert: false,
                  kind: "href",
                  refFile: null,
                  targetSourceFile: null
                },
                type: "link"
              }
            ],
            text: "this section",
            type: "text"
          },
          { text: " or ", type: "text" },
          {
            marks: [
              {
                attrs: {
                  anchor: null,
                  href: "https://example.com",
                  inert: true,
                  kind: "href",
                  refFile: null,
                  targetSourceFile: null
                },
                type: "link"
              }
            ],
            text: "the site",
            type: "text"
          }
        ],
        type: "paragraph"
      }
    ],
    type: "doc"
  };

  it("round-trips the link mark through fromJSON/toJSON unchanged", () => {
    const withIds = assignNodeIds(linkedDoc);
    const node = parseDocument(withIds);

    expect(node.type.name).toBe("doc");
    expect(serializeDocument(node)).toEqual(withIds);
  });

  it("keeps the linked text in the inline run so documentText stays gap-free (CJK safe, #340)", () => {
    // `见` + linked `周髀` + `之术` -> `见周髀之术`: a mark keeps the text in flow (an atom would not).
    const cjk: DocumentNodeJSON = {
      content: [
        {
          content: [
            { text: "见", type: "text" },
            {
              marks: [{ attrs: { anchor: "zhoubi", kind: "href" }, type: "link" }],
              text: "周髀",
              type: "text"
            },
            { text: "之术", type: "text" }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };

    expect(documentText(cjk)).toBe("见周髀之术");
    expect(isValidDocument(cjk)).toBe(true);
  });

  it("accepts safe authored hrefs and rejects unsafe or non-string hrefs", () => {
    expect(isSafeDocumentLinkHref("https://example.com")).toBe(true);
    expect(isSafeDocumentLinkHref("http://example.com")).toBe(true);
    expect(isSafeDocumentLinkHref("mailto:reader@example.com")).toBe(true);
    expect(isSafeDocumentLinkHref("#section")).toBe(true);
    expect(isSafeDocumentLinkHref("/library/work")).toBe(true);
    expect(isSafeDocumentLinkHref("//example.com")).toBe(false);
    expect(isSafeDocumentLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeDocumentLinkHref(42)).toBe(false);

    const unsafe: DocumentNodeJSON = {
      content: [
        {
          content: [
            {
              marks: [{ attrs: { href: "javascript:alert(1)" }, type: "link" }],
              text: "unsafe",
              type: "text"
            }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    expect(() => parseDocument(unsafe)).toThrow(DocumentValidationError);

    const wrongType: DocumentNodeJSON = {
      content: [
        {
          content: [
            {
              marks: [{ attrs: { href: 42 }, type: "link" }],
              text: "unsafe",
              type: "text"
            }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    expect(() => parseDocument(wrongType)).toThrow(DocumentValidationError);
  });
});

describe("parse / serialize round-trip (Node, no browser)", () => {
  it("round-trips a document using every node type through fromJSON/toJSON", () => {
    // The fixture covers all 23 node types, so a clean round-trip validates each spec at once.
    expect(nodeTypesIn(richDoc).size).toBe(documentNodeNames.length);

    const withIds = assignNodeIds(richDoc);
    const node = parseDocument(withIds);

    expect(node.type.name).toBe("doc");
    expect(serializeDocument(node)).toEqual(withIds);
  });

  it("validates without ids assigned (the id attribute defaults to null)", () => {
    expect(isValidDocument(richDoc)).toBe(true);
  });
});

describe("stable ids", () => {
  it("assigns an id to every addressable node and leaves text nodes unstamped", () => {
    const withIds = assignNodeIds(richDoc);

    everyNodeWithoutText(withIds, (node) => {
      // The root doc carries no id (UniqueID's "all" excludes `doc` and `text`); every block,
      // inline atom, and leaf below it does.
      if (node.type === "doc") {
        return;
      }
      expect(typeof node.attrs?.id).toBe("string");
      expect((node.attrs?.id as string).length).toBeGreaterThan(0);
    });

    const text = withIds.content?.[0]?.content?.[0];
    expect(text?.type).toBe("text");
    expect(text?.attrs).toBeUndefined();
  });

  it("is idempotent: an already-stamped document keeps its ids", () => {
    const once = assignNodeIds(richDoc);
    const twice = assignNodeIds(once);
    expect(twice).toEqual(once);
  });
});

describe("documentText", () => {
  it("concatenates descendant text in order across nested blocks", () => {
    const doc: DocumentNodeJSON = {
      content: [
        { content: [{ text: "Title", type: "text" }], type: "heading" },
        {
          content: [
            { text: "Hello ", type: "text" },
            { text: "world", type: "text" }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };

    expect(documentText(doc)).toBe("TitleHello world");
  });

  it("returns an empty string for a leaf node with neither text nor content", () => {
    // An image is a childless, textless atom — the content-absent branch must default to no text.
    expect(documentText({ type: "image" })).toBe("");
  });
});

describe("documentReadableText", () => {
  function listBlock(...items: string[]): DocumentNodeJSON {
    return {
      content: items.map((value) => ({
        content: [{ content: [{ text: value, type: "text" }], type: "paragraph" }],
        type: "listItem"
      })),
      type: "bulletList"
    };
  }

  it("separates a list's items with a single space so they do not run together (#503)", () => {
    const list = listBlock(
      "First list item mentions a falcon gliding above the valley.",
      "Second list item mentions a turtle walking the long sandy shore."
    );

    // documentText runs them together; the readable projection keeps a boundary between the items.
    expect(documentText(list)).toContain("valley.Second");
    expect(documentReadableText(list)).toBe(
      "First list item mentions a falcon gliding above the valley. " +
        "Second list item mentions a turtle walking the long sandy shore."
    );
  });

  it("leaves an inline run (paragraph) unseparated, matching documentText", () => {
    const paragraph: DocumentNodeJSON = {
      content: [
        { text: "Hello ", type: "text" },
        { text: "world", type: "text" }
      ],
      type: "paragraph"
    };

    expect(documentReadableText(paragraph)).toBe("Hello world");
  });

  it("separates stacked block children (a blockquote's paragraphs) with a space", () => {
    const blockquote: DocumentNodeJSON = {
      content: [
        { content: [{ text: "One.", type: "text" }], type: "paragraph" },
        { content: [{ text: "Two.", type: "text" }], type: "paragraph" }
      ],
      type: "blockquote"
    };

    expect(documentReadableText(blockquote)).toBe("One. Two.");
  });

  it("separates nested-list items at every level", () => {
    const nested: DocumentNodeJSON = {
      content: [
        {
          content: [
            { content: [{ text: "Outer.", type: "text" }], type: "paragraph" },
            listBlock("Inner.")
          ],
          type: "listItem"
        }
      ],
      type: "bulletList"
    };

    expect(documentReadableText(nested)).toBe("Outer. Inner.");
  });

  it("drops textless children so a figure reads as its caption alone (no leading space)", () => {
    const figure: DocumentNodeJSON = {
      content: [
        { attrs: { src: "x.png" }, type: "image" },
        { content: [{ text: "A caption.", type: "text" }], type: "figureCaption" }
      ],
      type: "figure"
    };

    expect(documentReadableText(figure)).toBe("A caption.");
  });

  it("returns an empty string for a leaf node with neither text nor content", () => {
    expect(documentReadableText({ type: "image" })).toBe("");
  });
});

describe("validation failures", () => {
  it("rejects an unknown node type", () => {
    const invalid = { content: [{ type: "bogusNode" }], type: "doc" };
    expect(isValidDocument(invalid)).toBe(false);
    expect(() => parseDocument(invalid)).toThrow(DocumentValidationError);
  });

  it("rejects content that breaks a node's content expression", () => {
    // A heading holds inline content only, so a nested paragraph is structurally invalid.
    const invalid = {
      content: [{ content: [{ content: [], type: "paragraph" }], type: "heading" }],
      type: "doc"
    };
    expect(isValidDocument(invalid)).toBe(false);
    expect(() => parseDocument(invalid)).toThrow(DocumentValidationError);
  });

  it("surfaces the underlying ProseMirror error as the cause", () => {
    try {
      parseDocument({ content: [{ type: "bogusNode" }], type: "doc" });
      expect.unreachable("parseDocument should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentValidationError);
      expect((error as DocumentValidationError).cause).toBeDefined();
    }
  });

  it("rejects a valid node that is not a document root", () => {
    // A bare paragraph deserializes and checks on its own, but the document boundary stores JSON
    // rooted at `doc`, so a block fragment is not a document.
    const fragment = { content: [{ text: "hi", type: "text" }], type: "paragraph" };
    expect(isValidDocument(fragment)).toBe(false);
    expect(() => parseDocument(fragment)).toThrow(DocumentValidationError);
  });
});

describe("documentBlockHeading", () => {
  it("reads a heading block's level and text", () => {
    const node: DocumentNodeJSON = {
      attrs: { level: 2 },
      content: [{ text: "Chapter One", type: "text" }],
      type: "heading"
    };
    expect(documentBlockHeading(node)).toEqual({ level: 2, title: "Chapter One" });
  });

  it("concatenates a heading's inline runs into its title", () => {
    const node: DocumentNodeJSON = {
      attrs: { level: 1 },
      content: [
        { marks: [{ type: "bold" }], text: "Bold", type: "text" },
        { text: " tail", type: "text" }
      ],
      type: "heading"
    };
    expect(documentBlockHeading(node)).toEqual({ level: 1, title: "Bold tail" });
  });

  it("omits the title for an empty heading so the outline can fall back to its untitled label", () => {
    expect(documentBlockHeading({ attrs: { level: 3 }, type: "heading" })).toEqual({ level: 3 });
  });

  it("defaults a heading with a missing or non-numeric level to level 1", () => {
    expect(documentBlockHeading({ type: "heading" })).toEqual({ level: 1 });
    expect(
      documentBlockHeading({
        attrs: { level: "2" },
        content: [{ text: "x", type: "text" }],
        type: "heading"
      })
    ).toEqual({ level: 1, title: "x" });
  });

  it("returns undefined for a non-heading block", () => {
    expect(
      documentBlockHeading({ content: [{ text: "body", type: "text" }], type: "paragraph" })
    ).toBeUndefined();
  });
});

describe("createTextDocument", () => {
  it("wraps text in a single paragraph whose plaintext round-trips exactly", () => {
    const doc = createTextDocument("I shipped the fix today.");

    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0]?.type).toBe("paragraph");
    expect(doc.content?.[0]?.content?.[0]).toMatchObject({
      text: "I shipped the fix today.",
      type: "text"
    });
    expect(documentText(doc)).toBe("I shipped the fix today.");
    expect(isValidDocument(doc)).toBe(true);
  });

  it("preserves newlines verbatim so the plaintext projection stays byte-identical", () => {
    const source = "line one\nline two";
    const doc = createTextDocument(source);

    expect(documentText(doc)).toBe(source);
  });

  it("preserves CJK text verbatim", () => {
    const doc = createTextDocument("今天我修好了部署。");

    expect(documentText(doc)).toBe("今天我修好了部署。");
  });

  it("yields an empty paragraph for an empty string", () => {
    const doc = createTextDocument("");

    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0]?.type).toBe("paragraph");
    expect(doc.content?.[0]?.content ?? []).toHaveLength(0);
    expect(documentText(doc)).toBe("");
    expect(isValidDocument(doc)).toBe(true);
  });
});
