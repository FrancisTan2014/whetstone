import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The desktop lookup popover's close-target fix (#460) lives in CSS, and jsdom has no layout to observe
// it, so this guards the root-cause change directly on the stylesheet: `.lookupClose` must carry a >=44px
// hit target (WCAG 2.5.5) in BOTH dimensions — the bare "✕" glyph measured only ~11x14px. Removing either
// min-size (the original bug) fails here.
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("lookup popover close target CSS (#460)", () => {
  it("gives the close control a >=44px hit target in both dimensions", () => {
    const close = rule("lookupClose");
    expect(close).toMatch(/min-inline-size:\s*44px/u);
    expect(close).toMatch(/min-block-size:\s*44px/u);
  });

  it("centers the glyph in the target", () => {
    const close = rule("lookupClose");
    expect(close).toMatch(/display:\s*inline-flex/u);
    expect(close).toMatch(/align-items:\s*center/u);
    expect(close).toMatch(/justify-content:\s*center/u);
  });
});

// The external dictionary deep-links (#502) render as bare text links; a mouse pointer measured them at
// only ~54x19px because the original 44px minimum was gated behind (pointer: coarse). jsdom has no
// layout, so this guards the root-cause change on the stylesheet directly: `.lookupExternalLink` must
// carry a >=44px hit target in BOTH dimensions unconditionally. Re-gating or removing either min-size
// (the original bug) fails here.
describe("lookup external dictionary link target CSS (#502)", () => {
  it("gives each external link a >=44px hit target in both dimensions", () => {
    const link = rule("lookupExternalLink");
    expect(link).toMatch(/min-inline-size:\s*44px/u);
    expect(link).toMatch(/min-block-size:\s*44px/u);
  });

  it("centers the label in the target", () => {
    const link = rule("lookupExternalLink");
    expect(link).toMatch(/display:\s*inline-flex/u);
    expect(link).toMatch(/align-items:\s*center/u);
    expect(link).toMatch(/justify-content:\s*center/u);
  });

  it("does not gate the target size behind a coarse-pointer media query", () => {
    // The bug was `.lookupExternalLink { min-height: 44px }` living only inside `@media (pointer: coarse)`,
    // so a mouse pointer never got the target. Assert no coarse-pointer block re-declares the link.
    expect(css).not.toMatch(/@media\s*\(pointer:\s*coarse\)\s*\{[^}]*\.lookupExternalLink/u);
  });
});
