import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The reader's Back pill (#549) must be a real, reachable control that never collides with the other
// reader chrome. Assert the shipped CSS: it is fixed and bottom-centered, its tap targets are >= 44px,
// and its position clears both the reading-tools rail (#377) and the mobile bottom tools bar — so a
// regression that drops it onto either fails here rather than in a screenshot.
const css = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

// The first `.readerBackPill { … }` block is the base rule; a later one inside the desktop media query
// overrides only its vertical offset.
const base = /\.readerBackPill\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
const controls =
  /\.readerBackPillReturn,\s*\.readerBackPillDismiss\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";

describe("reader back pill layout", () => {
  it("is a fixed, bottom-centered control", () => {
    expect(base).toMatch(/position:\s*fixed/u);
    expect(base).toMatch(/inset-inline-start:\s*50%/u);
    expect(base).toMatch(/transform:\s*translateX\(-50%\)/u);
  });

  it("clears the mobile bottom tools bar by sitting above the safe-area inset", () => {
    // The mobile .readingTools bar docks at inset-block-end: 0; the pill adds a bar-height clearance
    // on top of the safe-area inset, so the two never overlap.
    expect(base).toMatch(
      /inset-block-end:\s*calc\(env\(safe-area-inset-bottom\)\s*\+\s*3\.75rem\)/u
    );
  });

  it("drops to the bottom margin on desktop, where the rail is off to the side", () => {
    // The second `.readerBackPill { … }` block (inside the desktop media query) overrides the offset.
    const blocks = [...css.matchAll(/\.readerBackPill\s*\{([^}]*)\}/gu)];
    const desktop = blocks[1]?.[1] ?? "";
    expect(desktop).toMatch(/inset-block-end:\s*max\(1rem,\s*env\(safe-area-inset-bottom\)\)/u);
  });

  it("does not share the desktop rail's column (the rail is offset right of centre)", () => {
    // The desktop rail is pushed right of the reading column's centre; the pill stays centred, so they
    // occupy different horizontal bands and cannot overlap.
    const railDesktop =
      /@media\s*\(min-width:\s*56rem\)\s*\{[\s\S]*?\.readingTools\s*\{([^}]*)\}/u.exec(css)?.[1] ??
      "";
    expect(railDesktop).toMatch(/inset-inline-start:\s*calc\(50%\s*\+/u);
    expect(base).toMatch(/inset-inline-start:\s*50%/u);
  });

  it("gives both controls >= 44px tap targets", () => {
    expect(controls).toMatch(/min-block-size:\s*44px/u);
    expect(controls).toMatch(/min-inline-size:\s*44px/u);
  });
});
