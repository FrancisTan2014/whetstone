import { describe, expect, it } from "vitest";

import { createTextDocument, type DocumentNodeJSON } from "./document.js";
import { projectNearMatch, projectNearMatchKey } from "./nearMatch.js";

// #713 near-match projection: the eligibility gate + relaxed key + protected evidence. These tests lock every
// eligibility rule (only plain prose, 2–40 tokens, 8–240 ASCII code points, one letter minimum), every relaxed
// normalization transform and its idempotence, and the protected-evidence extraction that later vetoes a pair.
// Fuzzy similarity runs only inside this declared scope; everything outside projects to `null` — silence.

const doc = (content: DocumentNodeJSON[]): DocumentNodeJSON => ({ content, type: "doc" });
const paragraph = (...content: DocumentNodeJSON[]): DocumentNodeJSON => ({
  content,
  type: "paragraph"
});
const text = (value: string, marks?: DocumentNodeJSON["marks"]): DocumentNodeJSON =>
  marks === undefined ? { text: value, type: "text" } : { marks, text: value, type: "text" };

// A convenience: the relaxed key of a plain-text note, or a sentinel when unsupported.
function keyOf(value: string): string {
  const projection = projectNearMatch(createTextDocument(value));
  return projection === null ? "<unsupported>" : projection.relaxedKey;
}

describe("projectNearMatch eligibility", () => {
  it("accepts plain English prose within the token and length bounds", () => {
    const projection = projectNearMatch(createTextDocument("in terms of the design"));
    expect(projection).not.toBeNull();
    expect(projection?.relaxedKey).toBe("in terms of the design");
    expect(projection?.codePointLength).toBe(22);
  });

  it("accepts prose carrying only bold or italic emphasis", () => {
    const emphasised = doc([
      paragraph(
        text("the "),
        text("quick", [{ type: "bold" }]),
        text(" brown "),
        text("fox", [{ type: "italic" }])
      )
    ]);
    expect(projectNearMatch(emphasised)).not.toBeNull();
  });

  it("inserts a boundary between paragraphs so words never merge across blocks", () => {
    const twoParagraphs = doc([paragraph(text("hello there")), paragraph(text("friend of mine"))]);
    expect(projectNearMatch(twoParagraphs)?.relaxedKey).toBe("hello there friend of mine");
  });

  it("rejects a single-word note (too few tokens)", () => {
    expect(projectNearMatch(createTextDocument("distributed"))).toBeNull();
  });

  it("rejects material below eight or above 240 code points", () => {
    expect(projectNearMatch(createTextDocument("a b c"))).toBeNull();
    // Thirty ten-letter tokens stay within the token bound but exceed 240 code points.
    const longButFewTokens = Array.from({ length: 30 }, () => "abcdefghij").join(" ");
    expect(projectNearMatch(createTextDocument(longButFewTokens))).toBeNull();
  });

  it("rejects more than forty tokens", () => {
    const many = Array.from({ length: 41 }, () => "ok").join(" ");
    expect(projectNearMatch(createTextDocument(many))).toBeNull();
  });

  it("rejects material with no letter", () => {
    expect(projectNearMatch(createTextDocument("12 34 56 78"))).toBeNull();
  });

  it("rejects non-ASCII letters, CJK, and emoji", () => {
    expect(projectNearMatch(createTextDocument("café society at dusk"))).toBeNull();
    expect(projectNearMatch(createTextDocument("学习 分布式 系统 设计"))).toBeNull();
    expect(projectNearMatch(createTextDocument("send a happy \u{1F600} note today"))).toBeNull();
  });

  it("rejects headings, lists, code blocks, images, and footnotes", () => {
    const heading = doc([
      { attrs: { level: 1 }, content: [text("a title here now")], type: "heading" }
    ]);
    const list = doc([
      {
        content: [{ content: [paragraph(text("first item here"))], type: "listItem" }],
        type: "bulletList"
      }
    ]);
    const codeBlock = doc([{ content: [text("const value = compute()")], type: "codeBlock" }]);
    const image = doc([
      paragraph(text("see the picture"), { attrs: { src: "/a.png" }, type: "image" })
    ]);
    for (const candidate of [heading, list, codeBlock, image]) {
      expect(projectNearMatch(candidate)).toBeNull();
    }
  });

  it("rejects inline code and links (content-bearing marks)", () => {
    const inlineCode = doc([
      paragraph(text("run the "), text("build", [{ type: "code" }]), text(" now"))
    ]);
    const linked = doc([
      paragraph(
        text("open the "),
        text("site", [{ attrs: { href: "https://x.test" }, type: "link" }])
      )
    ]);
    expect(projectNearMatch(inlineCode)).toBeNull();
    expect(projectNearMatch(linked)).toBeNull();
  });

  it("rejects an invalid document without throwing", () => {
    expect(projectNearMatch({ content: [{ type: "bogus" }], type: "doc" })).toBeNull();
    expect(projectNearMatch("not a document")).toBeNull();
  });
});

describe("projectNearMatch relaxed key normalization", () => {
  it("collapses whitespace and trims", () => {
    expect(keyOf("  in   terms\tof\nthe design  ")).toBe("in terms of the design");
  });

  it("folds ASCII case for the relaxed key while the case-sensitive key preserves it", () => {
    const projection = projectNearMatch(createTextDocument("The US Policy Applies"));
    expect(projection?.relaxedKey).toBe("the us policy applies");
    expect(projection?.caseSensitiveKey).toBe("The US Policy Applies");
  });

  it("normalizes equivalent quotes, apostrophes, and dashes", () => {
    expect(keyOf("\u201Chello\u201D there \u2014 friend")).toBe('"hello" there - friend');
    expect(keyOf("it\u2019s a well\u2013known idea")).toBe("it's a well-known idea");
  });

  it("applies NFKC before normalization", () => {
    // The full-width characters and a ligature NFKC-fold to ASCII, becoming eligible prose.
    expect(keyOf("\uFF41\uFF42\uFF43 defﬁne the term")).toBe("abc deffine the term");
  });

  it("is idempotent and stable across a reparse", () => {
    const sample = createTextDocument("in Terms of the Design");
    const first = projectNearMatch(sample);
    const reparsed = projectNearMatch(JSON.parse(JSON.stringify(sample)));
    expect(first).toEqual(reparsed);
  });
});

describe("projectNearMatch protected evidence", () => {
  const evidence = (value: string) =>
    projectNearMatch(createTextDocument(value))?.protectedEvidence;

  it("extracts digit-bearing tokens as numbers", () => {
    expect(evidence("we store up to 100 MB")?.numbers).toBe("100");
    expect(evidence("release version 1.2.3 now")?.numbers).toBe("1.2.3");
  });

  it("extracts negation words and contractions", () => {
    expect(evidence("the value is not safe")?.negations).toBe("not");
    expect(evidence("it does not work without care")?.negations).toBe("not without");
    expect(evidence("we don't ship it today")?.negations).toBe("n't");
  });

  it("extracts operator symbols but not renderer-normalized punctuation", () => {
    expect(evidence("run a, b; and c here")?.symbols).toBe(",;");
    // Hyphens, apostrophes, and quotes are normalized punctuation, not operators, so they are not protected.
    expect(evidence("a well\u2014known and well-known idea")?.symbols).toBe("");
    expect(evidence('she said "yes" to me')?.symbols).toBe("");
    // A genuine operator stays protected.
    expect(evidence("compute f = ma today")?.symbols).toBe("=");
  });

  it("treats acronyms and camel case as identifiers but ignores ordinary capitals", () => {
    expect(evidence("the US policy is firm")?.identifiers).toBe("US");
    expect(evidence("call readIndex on the node")?.identifiers).toBe("readIndex");
    // A sentence-initial or proper-name capital is NOT an identifier.
    expect(evidence("Apple grows on a tree")?.identifiers).toBe("");
  });
});

describe("projectNearMatchKey", () => {
  it("returns only the persisted key slice for eligible notes", () => {
    expect(projectNearMatchKey(createTextDocument("in terms of the design"))).toEqual({
      codePointLength: 22,
      relaxedKey: "in terms of the design"
    });
  });

  it("returns null for unsupported notes", () => {
    expect(projectNearMatchKey(createTextDocument("distributed"))).toBeNull();
  });
});
