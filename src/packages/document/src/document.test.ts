import { describe, expect, it } from "vitest";

import {
  assignNodeIds,
  type DocumentNodeJSON,
  documentNodeNames,
  documentSchema,
  documentText,
  DocumentValidationError,
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
