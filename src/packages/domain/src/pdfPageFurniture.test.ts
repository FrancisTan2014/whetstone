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

// A running head that embeds its folio (#826) — `Chapter 2. Threads and Locks · 26` — is a different
// string on every page, so repetition and heading restatement only see it once one edge folio is removed.
describe("decidePageFurniture with an embedded folio", () => {
  it("excludes a running head whose folio-stripped form repeats across pages", () => {
    // The three instances share no normalized text at all; only the stripped form repeats.
    expect(
      rules([
        header("Chapter 2. Threads and Locks \u00b7 26", 40),
        body("Prose about locks."),
        header("Chapter 2. Threads and Locks \u00b7 38", 52)
      ])
    ).toEqual(["repeated-across-pages", null, "repeated-across-pages"]);
  });

  it("excludes a running head whose folio-stripped form matches a heading, seen only once", () => {
    expect(
      rules([
        heading("Day 2: Beyond Intrinsic Locks", 41),
        header("Day 2: Beyond Intrinsic Locks \u00b7 27", 41)
      ])
    ).toEqual([null, "matches-heading"]);
  });

  it("strips the folio behind any of the printer separators, at either edge", () => {
    // Each pair repeats the same head with a different folio, so exclusion proves the separator was
    // recognized: middle dot, pipe, em dash, hyphen, colon, and bare whitespace, trailing then leading.
    const pairs: readonly [string, string][] = [
      ["Threads and Locks \u00b7 26", "Threads and Locks \u00b7 38"],
      ["Threads and Locks | 26", "Threads and Locks | 38"],
      ["Threads and Locks \u2014 26", "Threads and Locks \u2014 38"],
      ["Threads and Locks - 26", "Threads and Locks - 38"],
      ["Threads and Locks: 26", "Threads and Locks: 38"],
      ["Threads and Locks 26", "Threads and Locks 38"],
      ["26 \u00b7 Threads and Locks", "38 \u00b7 Threads and Locks"],
      ["26 | Threads and Locks", "38 | Threads and Locks"],
      ["26 \u2014 Threads and Locks", "38 \u2014 Threads and Locks"],
      ["26 - Threads and Locks", "38 - Threads and Locks"],
      ["26: Threads and Locks", "38: Threads and Locks"],
      ["26 Threads and Locks", "38 Threads and Locks"]
    ];
    for (const [first, second] of pairs) {
      expect(rules([header(first, 40), footer(second, 52)]), `${first} / ${second}`).toEqual([
        "repeated-across-pages",
        "repeated-across-pages"
      ]);
    }
  });

  it("counts a separated folio and an embedded one as the same running head", () => {
    // Docling emits the head alone on some pages and combined with the folio on others; both forms are
    // the same printed running head, so one page of each reaches the repetition threshold.
    expect(
      rules([header("Chapter 5: Formatting", 121), header("Chapter 5: Formatting \u00b7 123", 123)])
    ).toEqual(["repeated-across-pages", "repeated-across-pages"]);
  });

  it("trims punctuation left behind by the folio, so the residue still matches a heading", () => {
    expect(rules([heading("Formatting", 120), header("Formatting. 121", 121)])).toEqual([
      null,
      "matches-heading"
    ]);
  });

  it("reports the item's own normalized text, not the folio-stripped comparison form", () => {
    // The evidence has to name the line that actually vanished, or an administrator cannot audit it.
    expect(
      excluded([
        header("Chapter 2. Threads and Locks \u00b7 26", 40),
        header("Chapter 2. Threads and Locks \u00b7 38", 52)
      ])
    ).toEqual([
      {
        kind: "excluded",
        normalizedText: "chapter 2. threads and locks \u00b7 26",
        rule: "repeated-across-pages"
      },
      {
        kind: "excluded",
        normalizedText: "chapter 2. threads and locks \u00b7 38",
        rule: "repeated-across-pages"
      }
    ]);
  });

  it("still matches a heading that itself ends in a number", () => {
    // The heading text carries the number, so only the UNSTRIPPED comparison can equal it.
    expect(rules([heading("Rule 34", 10), header("Rule 34", 11)])).toEqual([
      null,
      "matches-heading"
    ]);
  });

  it("still reports a bare folio as folio, never as stripped repetition", () => {
    expect(rules([footer("26", 40), footer("38", 52), footer("Page 26", 41)])).toEqual([
      "folio",
      "folio",
      "folio"
    ]);
  });

  it("never strips a body block that ends in a number, however often it repeats", () => {
    // The candidate-label gate is the outer guard: prose is never a folio-stripping candidate.
    expect(
      rules([
        body("Deadlock is covered in Chapter 2", 40),
        body("Deadlock is covered in Chapter 2", 52),
        body("Chapter 2. Threads and Locks \u00b7 26", 41)
      ])
    ).toEqual([null, null, null]);
  });

  it("never strips a number in the middle of a candidate", () => {
    // Only edge tokens are removable, so these two keep their differing numbers and never merge.
    expect(
      rules([header("Rule 26 for concurrency", 40), header("Rule 38 for concurrency", 52)])
    ).toEqual([null, null]);
  });

  it("requires a separator, so digits joined to the text are kept", () => {
    expect(rules([header("Threads and Locks26", 40), header("Threads and Locks38", 52)])).toEqual([
      null,
      null
    ]);
  });

  it("strips a folio of one to four digits, and nothing longer", () => {
    // Four digits is a real folio in a long book; five is not a page number, so those lines stay.
    expect(
      rules([
        header("Threads and Locks \u00b7 1004", 40),
        header("Threads and Locks \u00b7 1038", 52)
      ])
    ).toEqual(["repeated-across-pages", "repeated-across-pages"]);
    expect(
      rules([
        header("Threads and Locks \u00b7 10045", 40),
        header("Threads and Locks \u00b7 10046", 52)
      ])
    ).toEqual([null, null]);
  });

  it("strips at most one token, so a head fenced by numbers on both edges keeps one", () => {
    // Both lines shed only their trailing number; the leading folios still differ, so nothing merges and
    // the lines stay readable rather than being deleted on partial evidence.
    expect(
      rules([
        header("26 \u00b7 Chapter 2 \u00b7 26", 40),
        header("38 \u00b7 Chapter 2 \u00b7 38", 52)
      ])
    ).toEqual([null, null]);
  });

  it("keeps a lone chapter opener that merely carries a number", () => {
    // Docling labels some chapter openers `page_header`. One `Part 1` is unique after stripping too, so
    // it survives as readable content.
    expect(rules([header("Part 1", 5), body("Prose.")])).toEqual([null, null]);
  });

  it("refuses to strip when the residue is not substantive", () => {
    // A residue of bare digits, or one that is itself a folio, is no evidence of a running head. Each
    // pair would merge if the edge number were taken; because it is not, the lines are compared whole,
    // match nothing, and stay.
    expect(
      rules([
        header("26 \u00b7 27", 40),
        header("26 \u00b7 38", 52),
        footer("Page 26 \u00b7 27", 41),
        footer("Page 26 \u00b7 38", 53),
        footer("26 \u00b7 iv", 42),
        footer("38 \u00b7 iv", 54)
      ])
    ).toEqual([null, null, null, null, null, null]);
  });
});
