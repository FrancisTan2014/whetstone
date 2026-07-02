import { describe, expect, it } from "vitest";

import {
  epubContentType,
  ingestMarkdownRequestSchema,
  parseIngestMarkdownRequest,
  parseWorkAnchorIndex
} from "./contentContracts.js";

describe("parseIngestMarkdownRequest", () => {
  it("accepts a manual Markdown source", () => {
    expect(parseIngestMarkdownRequest({ kind: "manual", markdown: "# Title" })).toEqual({
      kind: "manual",
      markdown: "# Title"
    });
  });

  it("accepts an upload source with a .md file name", () => {
    expect(
      parseIngestMarkdownRequest({ fileName: "Notes.MD", kind: "upload", markdown: "Body." })
    ).toEqual({ fileName: "Notes.MD", kind: "upload", markdown: "Body." });
  });

  it("rejects a manual source with blank Markdown", () => {
    expect(ingestMarkdownRequestSchema.safeParse({ kind: "manual", markdown: "  " }).success).toBe(
      false
    );
  });

  it("rejects an upload source with a blank file name", () => {
    expect(
      ingestMarkdownRequestSchema.safeParse({ fileName: " ", kind: "upload", markdown: "Body." })
        .success
    ).toBe(false);
  });

  it("rejects an upload source whose file name is not Markdown", () => {
    expect(
      ingestMarkdownRequestSchema.safeParse({
        fileName: "notes.txt",
        kind: "upload",
        markdown: "Body."
      }).success
    ).toBe(false);
  });

  it("rejects an unknown source kind", () => {
    expect(ingestMarkdownRequestSchema.safeParse({ kind: "other", markdown: "x" }).success).toBe(
      false
    );
  });

  it("rejects unexpected keys", () => {
    expect(() =>
      parseIngestMarkdownRequest({ extra: true, kind: "manual", markdown: "x" })
    ).toThrow();
  });
});

describe("epubContentType", () => {
  it("is the standard EPUB media type", () => {
    expect(epubContentType).toBe("application/epub+zip");
  });
});

describe("parseWorkAnchorIndex", () => {
  it("accepts a work anchor index with a null and a non-null source file", () => {
    const index = {
      anchors: [
        { anchor: "fn1", blockEntryId: "b-1", sourceFile: "text/ch01.xhtml", unitEntryId: "u-1" },
        { anchor: "fn2", blockEntryId: "b-2", sourceFile: null, unitEntryId: "u-2" }
      ],
      workEntryId: "work-1"
    };

    expect(parseWorkAnchorIndex(index)).toEqual(index);
  });

  it("rejects an anchor entry missing its block id", () => {
    expect(() =>
      parseWorkAnchorIndex({
        anchors: [{ anchor: "fn1", sourceFile: null, unitEntryId: "u-1" }],
        workEntryId: "work-1"
      })
    ).toThrow();
  });

  it("rejects unexpected keys on an entry", () => {
    expect(() =>
      parseWorkAnchorIndex({
        anchors: [
          { anchor: "fn1", blockEntryId: "b-1", extra: true, sourceFile: null, unitEntryId: "u-1" }
        ],
        workEntryId: "work-1"
      })
    ).toThrow();
  });
});
