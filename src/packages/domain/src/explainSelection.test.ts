import { describe, expect, it } from "vitest";

import {
  buildSelectionContext,
  defaultExplainContextWindowChars,
  normalizeHeadword
} from "./explainSelection.js";

describe("buildSelectionContext", () => {
  it("returns the whole plaintext verbatim when the block already fits the budget", () => {
    const plaintext = "The quick brown fox jumps over the lazy dog.";
    expect(buildSelectionContext(plaintext, 4, 9)).toBe(plaintext);
  });

  it("centers a bounded window on a selection in the middle of a long block", () => {
    const plaintext = "a".repeat(2000) + "TARGET" + "b".repeat(2000);
    const startOffset = 2000;
    const endOffset = 2006;
    const context = buildSelectionContext(plaintext, startOffset, endOffset, 200);

    expect(context).toContain("TARGET");
    expect(context.length).toBeLessThanOrEqual(200);
    // Roughly centered: meaningful "a" padding before and "b" padding after.
    const targetIndex = context.indexOf("TARGET");
    expect(targetIndex).toBeGreaterThan(50);
    expect(context.length - (targetIndex + "TARGET".length)).toBeGreaterThan(50);
  });

  it("shifts the window to use its full budget when the selection sits near the END of a long block", () => {
    const prefix = "a".repeat(5000);
    const plaintext = `${prefix}TARGET`;
    const startOffset = prefix.length;
    const endOffset = plaintext.length;
    const context = buildSelectionContext(plaintext, startOffset, endOffset, 200);

    expect(context.endsWith("TARGET")).toBe(true);
    // The selection is at the very end, so the ENTIRE budget (minus the selection itself) should be
    // used as preceding context rather than only half of it wasted on nothing after the selection.
    expect(context.length).toBe(200);
  });

  it("shifts the window to use its full budget when the selection sits near the START of a long block", () => {
    const suffix = "b".repeat(5000);
    const plaintext = `TARGET${suffix}`;
    const context = buildSelectionContext(plaintext, 0, 6, 200);

    expect(context.startsWith("TARGET")).toBe(true);
    expect(context.length).toBe(200);
  });

  it("returns the selection verbatim, never truncated, when it already meets or exceeds the budget", () => {
    const selection = "x".repeat(250);
    const plaintext = "a".repeat(500) + selection + "b".repeat(500);
    const startOffset = 500;
    const endOffset = 500 + selection.length;
    const context = buildSelectionContext(plaintext, startOffset, endOffset, 200);

    expect(context).toBe(selection);
  });

  it("uses the documented default budget when none is supplied", () => {
    const plaintext = "z".repeat(5000);
    const context = buildSelectionContext(plaintext, 2000, 2010);
    expect(context.length).toBe(defaultExplainContextWindowChars);
  });

  it("leaves a centered window one character short of the budget when the padding can't split evenly, touching neither edge", () => {
    // maxContextLength=11, selectionLength=6 -> padding=floor((11-6)/2)=2, giving a 10-char window
    // (one short of 11) that sits well away from both the start and the end of the block — the
    // "already at full budget" and "shift toward an edge" branches must NOT fire here.
    const plaintext = `${"a".repeat(50)}TARGET${"a".repeat(50)}`;
    const context = buildSelectionContext(plaintext, 50, 56, 11);

    expect(context).toBe(plaintext.slice(48, 58));
    expect(context.length).toBe(10);
    expect(context).toContain("TARGET");
  });
});

describe("normalizeHeadword", () => {
  it("trims surrounding whitespace only", () => {
    expect(normalizeHeadword("  hello  ")).toBe("hello");
  });

  it("preserves internal whitespace and case exactly", () => {
    expect(normalizeHeadword(" Hello   World ")).toBe("Hello   World");
  });

  it("leaves an already-trimmed headword unchanged", () => {
    expect(normalizeHeadword("你好")).toBe("你好");
  });
});
