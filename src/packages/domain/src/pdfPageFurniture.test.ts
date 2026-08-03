import { describe, expect, it } from "vitest";

import {
  decidePageFurniture,
  isPageFurnitureCandidate,
  normalizePageFurnitureText,
  type PageFurnitureDecision,
  type PageFurnitureItem
} from "./pdfPageFurniture.js";

function header(text: string, pageNumber: number): PageFurnitureItem {
  return { label: "page_header", pageNumber, text };
}

function footer(text: string, pageNumber: number): PageFurnitureItem {
  return { label: "page_footer", pageNumber, text };
}

function body(text: string, pageNumber = 1): PageFurnitureItem {
  return { label: "text", pageNumber, text };
}

function heading(text: string, pageNumber = 1): PageFurnitureItem {
  return { label: "section_header", pageNumber, text };
}

// The reported reason per item, or null where the item stays readable body content. Asserting this
// shape keeps every test about the OBSERVABLE decision (kept vs removed, and why) rather than internals.
function rules(items: readonly PageFurnitureItem[]): (string | null)[] {
  return decidePageFurniture(items).map((decision) =>
    decision.kind === "excluded" ? decision.rule : null
  );
}

function excluded(
  items: readonly PageFurnitureItem[]
): Extract<PageFurnitureDecision, { kind: "excluded" }>[] {
  return decidePageFurniture(items).filter(
    (decision): decision is Extract<PageFurnitureDecision, { kind: "excluded" }> =>
      decision.kind === "excluded"
  );
}

describe("normalizePageFurnitureText", () => {
  it("collapses whitespace, trims, and lowercases", () => {
    expect(normalizePageFurnitureText("  Chapter   5:\nFormatting  ")).toBe(
      "chapter 5: formatting"
    );
  });

  it("treats a non-breaking space as a plain space", () => {
    expect(normalizePageFurnitureText("Chapter\u00a05")).toBe("chapter 5");
  });

  it("applies NFKC so a full-width folio compares equal to its ASCII form", () => {
    expect(normalizePageFurnitureText("\uff19\uff10")).toBe("90");
  });

  it("strips decorative punctuation from both ends but keeps it inside", () => {
    expect(normalizePageFurnitureText("\u2014 89 \u2014")).toBe("89");
    expect(normalizePageFurnitureText("| Chapter 5: Formatting |")).toBe("chapter 5: formatting");
    expect(normalizePageFurnitureText("[Martin].")).toBe("martin");
    expect(normalizePageFurnitureText("\u2022 Data/Object Anti-Symmetry")).toBe(
      "data/object anti-symmetry"
    );
  });

  it("normalizes a punctuation-and-space-only line to the empty string", () => {
    expect(normalizePageFurnitureText("  \u00b7 - \u2014  ")).toBe("");
  });
});

describe("isPageFurnitureCandidate", () => {
  it("accepts only docling's page_header and page_footer labels", () => {
    expect(isPageFurnitureCandidate("page_header")).toBe(true);
    expect(isPageFurnitureCandidate("page_footer")).toBe(true);
    expect(isPageFurnitureCandidate("text")).toBe(false);
    expect(isPageFurnitureCandidate("section_header")).toBe(false);
    expect(isPageFurnitureCandidate("sidebar")).toBe(false);
  });
});

describe("decidePageFurniture", () => {
  it("returns one decision per item, in source order", () => {
    const items = [body("Prose."), header("99", 3), body("More prose.")];
    const decisions = decidePageFurniture(items);
    expect(decisions).toHaveLength(3);
    expect(decisions.map((decision) => decision.kind)).toEqual(["body", "excluded", "body"]);
  });

  it("never considers a non-candidate label, whatever its text", () => {
    // A body paragraph that happens to be a bare number is content, not a folio.
    expect(
      rules([body("89"), heading("Bibliography"), { label: "code", pageNumber: 2, text: "" }])
    ).toEqual([null, null, null]);
  });

  it("excludes a candidate whose normalized text is empty", () => {
    expect(rules([header("   ", 1), footer("\u2014 \u00b7 |", 2)])).toEqual(["empty", "empty"]);
  });

  it("excludes arabic, roman, and explicit page-number folio shapes", () => {
    const decisions = rules([
      footer("93", 1),
      footer("1004", 2),
      footer("xii", 3),
      footer("IV", 4),
      footer("Page 89", 5),
      footer("p. 90", 6),
      footer("p91", 7)
    ]);
    expect(decisions).toEqual(Array.from({ length: 7 }, () => "folio"));
  });

  it("does not treat an over-long number or a numbered phrase as a folio", () => {
    // Only a bare 1-4 digit run is a folio shape; a longer number or a number with words is content
    // unless another rule (repetition, heading restatement) proves otherwise.
    expect(rules([header("10045", 1), footer("Section 12 of 40", 2)])).toEqual([null, null]);
  });

  it("excludes a candidate repeated on two or more distinct pages", () => {
    expect(
      rules([
        header("Chapter 5: Formatting", 121),
        body("Prose."),
        header("Chapter 5: Formatting", 123)
      ])
    ).toEqual(["repeated-across-pages", null, "repeated-across-pages"]);
  });

  it("counts distinct pages, not occurrences: twice on one page is not repetition", () => {
    expect(rules([header("Uncle Bob's Rules", 122), footer("Uncle Bob's Rules", 122)])).toEqual([
      null,
      null
    ]);
  });

  it("matches repetition across normalization differences", () => {
    expect(
      rules([header("Chapter\u00a05: Formatting", 10), header("  chapter 5:  formatting  ", 44)])
    ).toEqual(["repeated-across-pages", "repeated-across-pages"]);
  });

  it("excludes a unique candidate that restates a heading anywhere in the document", () => {
    // The running head appears once, but the document carries the same text as a real heading, so the
    // candidate is layout repetition of content that is already present as a block.
    expect(rules([header("The Law of Demeter", 128), heading("The Law of Demeter", 129)])).toEqual([
      "matches-heading",
      null
    ]);
  });

  it("matches a heading that appears earlier in the document, including a title", () => {
    expect(
      rules([{ label: "title", pageNumber: 1, text: "Clean Code" }, header("clean code", 2)])
    ).toEqual([null, "matches-heading"]);
  });

  it("keeps a unique candidate that matches no rule as readable body content", () => {
    // Docling labels some chapter openers `page_header`; discarding this would silently destroy content.
    expect(rules([header("Chapter 3: Functions", 32), body("Prose.")])).toEqual([null, null]);
  });

  it("reports the first matching rule: empty before folio, folio before repetition", () => {
    // An empty candidate repeated across pages is reported as empty, and a folio repeated on every page
    // is reported as a folio, so the audit trail names the most specific evidence.
    expect(rules([header("  ", 1), header("", 2), footer("12", 3), footer("12", 9)])).toEqual([
      "empty",
      "empty",
      "folio",
      "folio"
    ]);
  });

  it("reports repetition before heading restatement when both apply", () => {
    expect(
      rules([header("Formatting", 120), header("Formatting", 122), heading("Formatting", 119)])
    ).toEqual(["repeated-across-pages", "repeated-across-pages", null]);
  });

  it("carries the normalized text used for comparison on each exclusion", () => {
    expect(
      excluded([
        header("  Chapter\u00a05: Formatting \u2014 ", 4),
        footer("\u2014 89 \u2014", 4),
        header("| chapter 5: formatting |", 6)
      ])
    ).toEqual([
      { kind: "excluded", normalizedText: "chapter 5: formatting", rule: "repeated-across-pages" },
      { kind: "excluded", normalizedText: "89", rule: "folio" },
      { kind: "excluded", normalizedText: "chapter 5: formatting", rule: "repeated-across-pages" }
    ]);
  });

  it("returns no decisions for an empty body", () => {
    expect(decidePageFurniture([])).toEqual([]);
  });
});
