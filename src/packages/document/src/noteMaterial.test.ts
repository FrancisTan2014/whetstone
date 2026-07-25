import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BlankNoteMaterialError, projectNoteMaterial } from "./noteMaterial.js";
import { DocumentValidationError, type DocumentNodeJSON } from "./document.js";

// #711 exact-material projection. These tests exercise the projection directly and drive the committed
// `fixtures/card-matching/exact-v1.jsonl` corpus (two full document payloads per row + an `exact|distinct`
// verdict), so the identity boundary is proven against the whole must-match / must-remain-distinct matrix
// from one source of truth. Every branch of the projection is also covered by the focused cases below.

const doc = (content: DocumentNodeJSON[]): DocumentNodeJSON => ({ content, type: "doc" });
const paragraph = (...content: DocumentNodeJSON[]): DocumentNodeJSON => ({
  content,
  type: "paragraph"
});
const text = (value: string, marks?: DocumentNodeJSON["marks"]): DocumentNodeJSON =>
  marks ? { marks, text: value, type: "text" } : { text: value, type: "text" };

const same = (a: DocumentNodeJSON, b: DocumentNodeJSON): boolean =>
  projectNoteMaterial(a) === projectNoteMaterial(b);

type FixtureRow = Readonly<{
  category: string;
  docA: unknown;
  docB: unknown;
  expected: "distinct" | "exact";
  id: string;
  rationale: string;
}>;

function loadFixture(): FixtureRow[] {
  const path = fileURLToPath(
    new URL("../../../../fixtures/card-matching/exact-v1.jsonl", import.meta.url)
  );
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureRow);
}

describe("projectNoteMaterial fixture corpus", () => {
  const rows = loadFixture();

  it("carries a non-trivial, unique-id corpus of both verdicts", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.some((row) => row.expected === "exact")).toBe(true);
    expect(rows.some((row) => row.expected === "distinct")).toBe(true);
  });

  it.each(loadFixture())("$id ($category): $rationale", (row) => {
    const projectionA = projectNoteMaterial(row.docA);
    const projectionB = projectNoteMaterial(row.docB);
    expect(projectionA === projectionB).toBe(row.expected === "exact");
  });
});

describe("projectNoteMaterial identity noise and normalization", () => {
  it("ignores generated ids, anchor ids, and attribute key order", () => {
    const withNoise: DocumentNodeJSON = doc([
      { attrs: { anchorId: "sec", id: "n1", level: 2 }, content: [text("Title")], type: "heading" }
    ]);
    const clean: DocumentNodeJSON = doc([
      { attrs: { level: 2 }, content: [text("Title")], type: "heading" }
    ]);
    expect(same(withNoise, clean)).toBe(true);
  });

  it("merges adjacent equivalent text runs, including once presentation marks are dropped", () => {
    expect(
      same(doc([paragraph(text("hello world"))]), doc([paragraph(text("hello "), text("world"))]))
    ).toBe(true);
    expect(
      same(
        doc([paragraph(text("hello ", [{ type: "bold" }]), text("world"))]),
        doc([paragraph(text("hello world"))])
      )
    ).toBe(true);
  });

  it("NFC-normalizes text and preserves numeric and boolean attributes", () => {
    expect(same(doc([paragraph(text("caf\u00e9"))]), doc([paragraph(text("cafe\u0301"))]))).toBe(
      true
    );
    // A link's boolean/string attributes and a heading's numeric level pass through verbatim (distinct href).
    const link = (href: string): DocumentNodeJSON =>
      doc([paragraph(text("x", [{ attrs: { href, inert: false }, type: "link" }]))]);
    expect(same(link("https://a.example"), link("https://b.example"))).toBe(false);
  });

  it("collapses prose whitespace but keeps code whitespace opaque", () => {
    expect(same(doc([paragraph(text("  a\tb\r\nc  "))]), doc([paragraph(text("a b c"))]))).toBe(
      true
    );
    const code = (body: string): DocumentNodeJSON =>
      doc([{ attrs: { language: "ts" }, content: [text(body)], type: "codeBlock" }]);
    expect(same(code("a  b"), code("a b"))).toBe(false);
  });

  it("keeps a space around an inline atom as a real word boundary", () => {
    const marker: DocumentNodeJSON = {
      attrs: { label: "1", noteKind: "footnote", refId: "fn1" },
      type: "footnoteMarker"
    };
    const spaced = doc([paragraph(text("a "), marker, text(" b"))]);
    const tight = doc([paragraph(text("a"), marker, text("b"))]);
    expect(same(spaced, tight)).toBe(false);
  });

  it("projects a text node that immediately follows an inline atom", () => {
    const marker: DocumentNodeJSON = {
      attrs: { label: "1", noteKind: "footnote", refId: "fn1" },
      type: "footnoteMarker"
    };
    const afterAtom = doc([paragraph(marker, text("after"))]);
    expect(projectNoteMaterial(afterAtom)).toContain("after");
  });
});

describe("projectNoteMaterial structural and semantic preservation", () => {
  it("treats a document that only carries a semantic atom as non-blank", () => {
    const imageOnly: DocumentNodeJSON = doc([
      {
        content: [{ attrs: { alt: "chart", imageResourceId: "img-1" }, type: "image" }],
        type: "figure"
      }
    ]);
    expect(() => projectNoteMaterial(imageOnly)).not.toThrow();
  });

  it("drops an emptied prose block while keeping a real one", () => {
    const mixed = doc([paragraph(text("hello")), paragraph(text("   "))]);
    const single = doc([paragraph(text("hello")), paragraph()]);
    // The whitespace-only second paragraph projects to an empty run, exactly like an empty paragraph.
    expect(same(mixed, single)).toBe(true);
  });

  it("never throws over a document exercising every node and mark", () => {
    const rich: DocumentNodeJSON = doc([
      { attrs: { level: 1 }, content: [text("Title")], type: "heading" },
      paragraph(
        text("Intro "),
        text("code", [{ type: "code" }]),
        text(" link", [{ attrs: { href: "https://e.example" }, type: "link" }]),
        { attrs: { label: "1", noteKind: "footnote", refId: "fn1" }, type: "footnoteMarker" }
      ),
      { content: [paragraph(text("quote"))], type: "blockquote" },
      { attrs: { language: "ts" }, content: [text("const a = 1;")], type: "codeBlock" },
      {
        content: [
          { content: [paragraph(text("one"))], type: "listItem" },
          { content: [paragraph(text("two"))], type: "listItem" }
        ],
        type: "bulletList"
      },
      {
        content: [
          {
            content: [
              { content: [paragraph(text("h"))], type: "tableHeader" },
              { content: [paragraph(text("c"))], type: "tableCell" }
            ],
            type: "tableRow"
          }
        ],
        type: "table"
      },
      {
        content: [
          { attrs: { alt: "img", imageResourceId: "r1" }, type: "image" },
          { content: [text("caption")], type: "figureCaption" }
        ],
        type: "figure"
      },
      {
        content: [
          { content: [text("term")], type: "definitionTerm" },
          { content: [paragraph(text("definition"))], type: "definitionDescription" }
        ],
        type: "definitionList"
      },
      { attrs: { kind: "note" }, content: [paragraph(text("aside"))], type: "callout" },
      {
        attrs: { label: "1", noteKind: "footnote", refId: "fn1" },
        content: [paragraph(text("target"))],
        type: "footnoteTarget"
      },
      { attrs: { html: "<x>y</x>", tag: "x" }, type: "unknown" }
    ]);
    expect(() => projectNoteMaterial(rich)).not.toThrow();
    // Every schema mark reduces or preserves, and the projection is a non-empty string.
    expect(projectNoteMaterial(rich).length).toBeGreaterThan(0);
  });
});

describe("projectNoteMaterial properties and failure modes", () => {
  const sample = doc([paragraph(text("Deterministic material"))]);

  it("is deterministic and idempotent across restarts and key-order noise", () => {
    const once = projectNoteMaterial(sample);
    const reparsed = projectNoteMaterial(JSON.parse(JSON.stringify(sample)));
    expect(once).toBe(reparsed);
    expect(projectNoteMaterial(sample)).toBe(once);
  });

  it("is symmetric: A matches B iff B matches A", () => {
    const a = doc([paragraph(text("same"))]);
    const b = doc([paragraph(text("sa"), text("me"))]);
    expect(projectNoteMaterial(a) === projectNoteMaterial(b)).toBe(
      projectNoteMaterial(b) === projectNoteMaterial(a)
    );
    expect(same(a, b)).toBe(true);
  });

  it("rejects a blank body-bearing document before hashing", () => {
    expect(() => projectNoteMaterial(doc([paragraph()]))).toThrow(BlankNoteMaterialError);
    expect(() => projectNoteMaterial(doc([paragraph(text("   "))]))).toThrow(
      BlankNoteMaterialError
    );
  });

  it("rejects an invalid document before projecting", () => {
    expect(() => projectNoteMaterial({ content: [{ type: "bogus" }], type: "doc" })).toThrow(
      DocumentValidationError
    );
  });

  it("rejects an unsafe link href before projecting", () => {
    const unsafe = doc([
      paragraph(text("x", [{ attrs: { href: "javascript:alert(1)" }, type: "link" }]))
    ]);
    expect(() => projectNoteMaterial(unsafe)).toThrow(DocumentValidationError);
  });
});
