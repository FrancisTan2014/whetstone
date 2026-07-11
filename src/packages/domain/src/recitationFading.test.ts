import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECITATION_SUPPORT_LEVEL,
  isRecitationSupportLevel,
  projectRecitationSupport,
  recitationSupportLevels,
  supportLevelShowsTarget,
  type RecitationVisibleSupportLevel,
  type SupportProjection
} from "./recitationFading.js";

// Render a projection to a compact, readable string: shown text verbatim, a masked run as `‹n›`, lines
// joined by "\n". This lets a test assert the exact fading without restating the segment structure.
function render(projection: SupportProjection): string {
  return projection.lines
    .map((line) =>
      line
        .map((segment) => (segment.kind === "shown" ? segment.text : `‹${segment.length}›`))
        .join("")
    )
    .join("\n");
}

// The canonical text a masked run hides is the original characters at those positions — used only to
// prove a projection never leaks them (the segment carries a length, not this text).
function maskedLengths(projection: SupportProjection): number[] {
  return projection.lines.flatMap((line) =>
    line.flatMap((segment) => (segment.kind === "masked" ? [segment.length] : []))
  );
}

describe("recitation support levels", () => {
  it("orders the four levels most-support to least", () => {
    expect(recitationSupportLevels).toEqual(["full", "reduced", "first", "hidden"]);
  });

  it("defaults a fresh passage to full visual support", () => {
    expect(DEFAULT_RECITATION_SUPPORT_LEVEL).toBe("full");
  });

  it("recognizes only the four known levels", () => {
    for (const level of recitationSupportLevels) {
      expect(isRecitationSupportLevel(level)).toBe(true);
    }
    expect(isRecitationSupportLevel("some_other")).toBe(false);
    expect(isRecitationSupportLevel(undefined)).toBe(false);
  });

  it("treats every level except hidden as showing the target", () => {
    expect(supportLevelShowsTarget("full")).toBe(true);
    expect(supportLevelShowsTarget("reduced")).toBe(true);
    expect(supportLevelShowsTarget("first")).toBe(true);
    expect(supportLevelShowsTarget("hidden")).toBe(false);
  });
});

describe("projectRecitationSupport — full", () => {
  it("shows the whole passage verbatim, one segment per line", () => {
    const text = "白日依山盡，黃河入海流。\nThe quick brown fox.";
    const projection = projectRecitationSupport(text, "full");
    expect(render(projection)).toBe(text);
    expect(maskedLengths(projection)).toEqual([]);
    expect(projection.lines[0]).toEqual([{ kind: "shown", text: "白日依山盡，黃河入海流。" }]);
  });

  it("preserves blank lines as empty segment lists", () => {
    const projection = projectRecitationSupport("first\n\nthird", "full");
    expect(projection.lines).toEqual([
      [{ kind: "shown", text: "first" }],
      [],
      [{ kind: "shown", text: "third" }]
    ]);
  });
});

describe("projectRecitationSupport — Chinese, by character clause", () => {
  it("reduced shows the first half of each punctuation-delimited clause", () => {
    const projection = projectRecitationSupport("白日依山盡，黃河入海流。", "reduced");
    // 5-character clauses keep the first 3 (ceil), mask the last 2; commas/periods stay visible.
    expect(render(projection)).toBe("白日依‹2›，黃河入‹2›。");
  });

  it("first shows only the first character of each clause, keeping punctuation", () => {
    const projection = projectRecitationSupport("白日依山盡，黃河入海流。", "first");
    expect(render(projection)).toBe("白‹4›，黃‹4›。");
  });

  it("keeps a short one-character clause fully visible", () => {
    expect(render(projectRecitationSupport("春，", "reduced"))).toBe("春，");
    expect(render(projectRecitationSupport("春，", "first"))).toBe("春，");
  });

  it("preserves non-delimiter punctuation such as quotation marks", () => {
    const projection = projectRecitationSupport("「白日依山盡」。", "first");
    // The brackets are punctuation (shown), only content characters mask.
    expect(render(projection)).toBe("「白‹4›」。");
  });
});

describe("projectRecitationSupport — whitespace-delimited, by word", () => {
  it("reduced shows the first half of the words and masks the rest", () => {
    const projection = projectRecitationSupport("The quick brown fox.", "reduced");
    expect(render(projection)).toBe("The quick ‹5› ‹3›.");
  });

  it("first shows only the first word of each clause", () => {
    const projection = projectRecitationSupport("The quick brown fox.", "first");
    expect(render(projection)).toBe("The ‹5› ‹5› ‹3›.");
  });

  it("reduces each clause independently across sentence punctuation", () => {
    const projection = projectRecitationSupport("Go now. Stay here later.", "first");
    // Clause 1: "Go now." -> first word "Go"; clause 2: "Stay here later." -> first word "Stay".
    expect(render(projection)).toBe("Go ‹3›. Stay ‹4› ‹5›.");
  });

  it("keeps a single-word clause fully visible", () => {
    expect(render(projectRecitationSupport("Alone.", "reduced"))).toBe("Alone.");
    expect(render(projectRecitationSupport("Alone.", "first"))).toBe("Alone.");
  });

  it("keeps a contraction as one whitespace token, never splitting on the apostrophe", () => {
    // "Don't" is a single token; only "stop" masks. The trailing period stays visible (a delimiter).
    expect(render(projectRecitationSupport("Don't stop.", "first"))).toBe("Don't ‹4›.");
    expect(render(projectRecitationSupport("Don't stop now.", "reduced"))).toBe("Don't stop ‹3›.");
  });

  it("keeps a hyphenated word as one whitespace token, never splitting on the hyphen", () => {
    // "well-known" is one token (10 code points); it is shown whole or masked whole, not split.
    expect(render(projectRecitationSupport("well-known phrase.", "first"))).toBe("well-known ‹6›.");
    const masked = projectRecitationSupport("state a well-known phrase.", "first");
    expect(render(masked)).toBe("state ‹1› ‹10› ‹6›.");
  });

  it("attaches leading and trailing quotes to the token they wrap", () => {
    // A quoted word is a single whitespace token, masked with its quotes rather than leaking them.
    expect(render(projectRecitationSupport('say "hello" now.', "first"))).toBe("say ‹7› ‹3›.");
  });
});

describe("projectRecitationSupport — structure and edge cases", () => {
  it("chooses behavior per clause in a mixed-script passage without corrupting characters", () => {
    const projection = projectRecitationSupport("Hello，世界。", "first");
    // English clause stays token-based (one word shown); Chinese clause fades by character.
    expect(render(projection)).toBe("Hello，世‹1›。");
  });

  it("preserves line breaks, fading each line on its own", () => {
    const projection = projectRecitationSupport("白日依山盡，\n黃河入海流。", "first");
    expect(render(projection)).toBe("白‹4›，\n黃‹4›。");
    expect(projection.lines).toHaveLength(2);
  });

  it("leaves a punctuation-only or empty clause untouched", () => {
    expect(render(projectRecitationSupport("……", "reduced"))).toBe("……");
    expect(render(projectRecitationSupport("", "first"))).toEqual("");
  });

  it("fades a final clause that has no trailing delimiter", () => {
    // A line ending mid-clause (no period/comma) still fades: the trailing clause is projected too.
    expect(render(projectRecitationSupport("白日依山盡", "first"))).toBe("白‹4›");
    expect(render(projectRecitationSupport("The quick brown fox", "reduced"))).toBe(
      "The quick ‹5› ‹3›"
    );
  });

  it("never splits an emoji, masking whole code points", () => {
    const projection = projectRecitationSupport("😀😀😀 fox.", "reduced");
    // Two words: the emoji run stays, "fox" is masked as 3 code points (not UTF-16 units).
    expect(render(projection)).toBe("😀😀😀 ‹3›.");
    expect(maskedLengths(projection)).toEqual([3]);
  });

  it("counts a multi-code-point emoji word as its code-point length when masked", () => {
    const projection = projectRecitationSupport("keep 😀😀.", "first");
    expect(render(projection)).toBe("keep ‹2›.");
  });
});

describe("projectRecitationSupport — never mutates the canonical source", () => {
  const cases: ReadonlyArray<{ level: RecitationVisibleSupportLevel; text: string }> = [
    { level: "full", text: "白日依山盡，黃河入海流。" },
    { level: "reduced", text: "The quick brown fox.\n白日依山盡，" },
    { level: "first", text: "Hello，世界。\n\nGo now." }
  ];

  it("reads the input without changing it, and full projection recovers it", () => {
    for (const { level, text } of cases) {
      const before = text;
      const projection = projectRecitationSupport(text, level);
      expect(text).toBe(before);
      // The full projection of the same text is exactly the canonical text, proving the source itself
      // is untouched and available for reveal/copy/search.
      expect(render(projectRecitationSupport(text, "full"))).toBe(text);
      expect(projection.lines.length).toBe(text.split("\n").length);
    }
  });
});
