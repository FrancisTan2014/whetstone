import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The reader is framed inside the app shell (#638): its immersive chrome must be scoped to the
// reader's own frame, not pinned to the viewport. A viewport-`fixed` header painted over the shell's
// utility bar (top) and navigation (bottom), intercepting their controls — the reviewer's blocker.
// Assert the structural invariant that prevents a regression back to viewport-fixed chrome:
//   - the frame `.readerReadingMain` is `position: relative` (the containing block for the chrome),
//     with its own inner `.readerReadingScroll` scroller (the window does not scroll in the shell);
//   - the chrome (`.readingHeader` and its title/progress/tools) is `position: absolute`, so it
//     resolves against that frame and stays clear of the shell's bars;
//   - the display-only title and progress line are `pointer-events: none`, so they never intercept a
//     tap meant for a control beneath them.
const theme = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");
const base = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

// The first (base, non-media) rule for a selector: the declarations before the first closing brace.
function baseRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("reader chrome scope", () => {
  it("frames the reading area with a relative, inner-scrolling container", () => {
    const main = baseRule(base, ".readerReadingMain");
    expect(main).toMatch(/position:\s*relative/u);

    const scroller = baseRule(base, ".readerReadingScroll");
    expect(scroller).toMatch(/overflow-y:\s*auto/u);
  });

  it("scopes the chrome to the frame with position: absolute, never viewport-fixed", () => {
    for (const selector of [".readingHeader", ".readingHeaderTitle", ".readingProgress"]) {
      const rule = baseRule(theme, selector);
      expect(rule).toMatch(/position:\s*absolute/u);
      expect(rule).not.toMatch(/position:\s*fixed/u);
    }

    // `.readingTools` has media-query variants; the base (non-media) rule carries the positioning.
    const tools = baseRule(theme, ".readingTools");
    expect(tools).toMatch(/position:\s*absolute/u);
    expect(tools).not.toMatch(/position:\s*fixed/u);
  });

  it("keeps the display-only title and progress transparent to input", () => {
    expect(baseRule(theme, ".readingHeaderTitle")).toMatch(/pointer-events:\s*none/u);
    expect(baseRule(theme, ".readingProgress")).toMatch(/pointer-events:\s*none/u);
  });
});
