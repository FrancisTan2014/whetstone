import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Code blocks must wrap inside the reading measure at EVERY width (#814). Before this, `.reader pre`
// only wrapped below 55.999rem (#197) and kept a deliberate desktop `overflow-x` scroll (#61) — and
// since extracted PDF code arrives as ONE long line with its authored line breaks lost, a desktop
// listing became a single clipped line behind a scrollbar the reader never sees.
//
// theme.css is the artifact the reader actually renders, so this asserts the real cascade rather than
// a restated constant. jsdom performs no layout, so the oracle is the set of declarations that
// *structurally* decide horizontal overflow of a 200-character unbroken line:
//   - `white-space: pre-wrap` — wraps while keeping whitespace significant (leading indentation and
//     blank lines survive); `pre` / `nowrap` / `normal` / `pre-line` would each break code or wrapping.
//   - `overflow-wrap: anywhere` — breaks an unbreakable token AND, unlike `break-word`, shrinks the
//     block's min-content width, so a listing can never widen the reading column or the page.
//   - exactly ONE rule per selector, none of it inside a width media query — so the removed
//     `max-width: 55.999rem` special case cannot be duplicated and desktop scroll cannot silently
//     return under a breakpoint.
const raw = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

// Comments quote selectors and property names; strip them so neither can satisfy an assertion.
const css = raw.replace(/\/\*[\s\S]*?\*\//gu, "");

type MediaSplit = Readonly<{
  // Each top-level `@media ... { ... }` block, braces balanced.
  inside: readonly string[];
  // Everything else: the declarations that apply at every width.
  outside: string;
}>;

function splitAtMediaQueries(source: string): MediaSplit {
  const inside: string[] = [];
  const outside: string[] = [];
  let cursor = 0;
  let start = source.indexOf("@media", cursor);

  while (start !== -1) {
    outside.push(source.slice(cursor, start));

    let depth = 0;
    let index = source.indexOf("{", start);

    while (index < source.length) {
      const char = source[index];

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          index += 1;
          break;
        }
      }

      index += 1;
    }

    inside.push(source.slice(start, index));
    cursor = index;
    start = source.indexOf("@media", cursor);
  }

  outside.push(source.slice(cursor));

  return { inside, outside: outside.join("") };
}

const { inside: mediaBlocks, outside: everyWidth } = splitAtMediaQueries(css);

// Every rule body whose (comma-separated) selector list names `selector` exactly — anywhere in the
// sheet, including inside a media query. Finds grouped rules (`.reader pre, .reader pre code {`) too.
function rulesTargeting(source: string, selector: string): readonly string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/gu;
  let match = rule.exec(source);

  while (match !== null) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim().replace(/\s+/gu, " "));

    if (selectors.includes(selector)) {
      bodies.push(match[2] ?? "");
    }

    match = rule.exec(source);
  }

  return bodies;
}

function declarationsOf(source: string, selector: string): string {
  const bodies = rulesTargeting(source, selector);

  if (bodies.length !== 1) {
    throw new Error(`Expected exactly one \`${selector}\` rule in scope, found ${bodies.length}.`);
  }

  return bodies[0] as string;
}

const codeSelectors = [".reader pre", ".reader pre code"] as const;

describe("reader code block wrapping", () => {
  it("wraps code blocks and breaks long unbroken tokens at every width", () => {
    for (const selector of codeSelectors) {
      const body = declarationsOf(everyWidth, selector);
      expect(body).toMatch(/white-space:\s*pre-wrap\s*;/u);
      // `anywhere`, not `break-word`: only `anywhere` shrinks min-content, so a 200-character line
      // cannot widen the reading column past its measure.
      expect(body).toMatch(/overflow-wrap:\s*anywhere\s*;/u);
    }
  });

  it("keeps the wrap out of every media query, so a width breakpoint cannot restore the scroll", () => {
    for (const block of mediaBlocks) {
      for (const selector of codeSelectors) {
        expect(rulesTargeting(block, selector)).toEqual([]);
      }
    }
  });

  it("declares each code-block rule exactly once, so no later rule re-collapses the wrap", () => {
    for (const selector of codeSelectors) {
      const bodies = rulesTargeting(css, selector);
      expect(bodies).toHaveLength(1);
      // A non-wrapping (or whitespace-collapsing) white-space would restore the overflow or destroy
      // the listing's leading indentation.
      expect(bodies[0]).not.toMatch(/white-space:\s*(?:pre|nowrap|normal|pre-line)\s*[;}]/u);
    }
  });

  it("preserves code semantics and keeps unbreakable content inside the block, not the page", () => {
    expect(declarationsOf(everyWidth, ".reader pre code")).toMatch(
      /font-family:\s*var\(--font-mono\)/u
    );
    // Wrapped text never reaches it, but content that genuinely cannot break stays contained in the
    // block instead of spilling across the reading surface or scrolling the page sideways.
    expect(declarationsOf(everyWidth, ".reader pre")).toMatch(/overflow-x:\s*auto/u);
  });

  it("leaves inline code and the shared editor's own code presentation alone", () => {
    const inlineCode = declarationsOf(everyWidth, ".reader :not(pre) > code");
    expect(inlineCode).not.toMatch(/white-space/u);
    expect(inlineCode).not.toMatch(/overflow-wrap/u);

    // The editor is an authoring viewport, not the reading measure: it keeps its own horizontal
    // scroll and gains no wrap from the reader-scoped rule.
    const editorCode = declarationsOf(everyWidth, ".richContentEditorContent pre");
    expect(editorCode).toMatch(/overflow-x:\s*auto/u);
    expect(editorCode).not.toMatch(/white-space/u);
    expect(editorCode).not.toMatch(/overflow-wrap/u);
  });
});
