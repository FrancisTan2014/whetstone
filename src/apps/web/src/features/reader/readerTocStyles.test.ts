import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The reader table-of-contents target-size fix (#476) lives in CSS, and jsdom has no layout to observe
// it, so this guards the root-cause change directly on the stylesheet: a TOC item (`.readerTocItem`, the
// list-mode row button) must be a >=44px hit target — it rendered only ~36px tall. The tree-mode rows
// already meet the target via `.readerTocRow`, asserted here too so the whole TOC contract stays green.
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

// Match a full selector's block, anchored to the start of a line so a standalone rule (e.g.
// `.readerTocEntry {`) is not confused with a descendant rule (`.readerTocRow .readerTocEntry {`).
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "mu").exec(css)?.[1] ?? "";
}

describe("reader table-of-contents target-size CSS (#476)", () => {
  it("gives a TOC item a >=44px hit target, with its label vertically centered", () => {
    const item = rule("readerTocItem");
    expect(item).toMatch(/min-block-size:\s*44px/u);
    expect(item).toMatch(/display:\s*flex/u);
    expect(item).toMatch(/align-items:\s*center/u);
  });

  it("keeps the tree row and its disclosure control at >=44px", () => {
    expect(rule("readerTocRow")).toMatch(/min-block-size:\s*44px/u);
    const disclosure = rule("readerTocDisclosure");
    expect(disclosure).toMatch(/min-block-size:\s*44px/u);
    expect(disclosure).toMatch(/min-inline-size:\s*44px/u);
  });
});

describe("reader table-of-contents hierarchy redesign (#514)", () => {
  it("styles four depth tiers distinctly by size, weight, and colour", () => {
    // Depth >=3 is the base tier on the node (smallest, muted); depths 0-2 override.
    const base = block(".readerTocNode");
    expect(base).toMatch(/--toc-entry-size:\s*0\.8125rem/u);
    expect(base).toMatch(/--toc-entry-weight:\s*400/u);
    expect(base).toMatch(/--toc-entry-color:\s*var\(--color-text-muted\)/u);

    const depth0 = block('.readerTocNode[data-depth="0"]');
    expect(depth0).toMatch(/--toc-entry-size:\s*0\.95rem/u);
    expect(depth0).toMatch(/--toc-entry-weight:\s*600/u);
    expect(depth0).toMatch(/--toc-entry-color:\s*var\(--color-text\)/u);

    const depth1 = block('.readerTocNode[data-depth="1"]');
    expect(depth1).toMatch(/--toc-entry-size:\s*0\.9rem/u);
    expect(depth1).toMatch(/--toc-entry-weight:\s*500/u);
    expect(depth1).toMatch(/--toc-entry-color:\s*var\(--color-text\)/u);

    const depth2 = block('.readerTocNode[data-depth="2"]');
    expect(depth2).toMatch(/--toc-entry-size:\s*0\.875rem/u);
    expect(depth2).toMatch(/--toc-entry-weight:\s*400/u);
    expect(depth2).toMatch(/--toc-entry-color:\s*var\(--color-text\)/u);

    // The entry consumes the per-depth tokens, so hierarchy reads by type, not indent alone.
    const entry = block(".readerTocEntry");
    expect(entry).toMatch(/font-size:\s*var\(--toc-entry-size\)/u);
    expect(entry).toMatch(/font-weight:\s*var\(--toc-entry-weight\)/u);
    expect(entry).toMatch(/color:\s*var\(--toc-entry-color\)/u);
  });

  it("keeps the active entry the most prominent row, overriding its tier colour", () => {
    // The tier colour is applied by the single-class `.readerTocEntry` rule; the active treatment is a
    // more specific `[aria-current]` rule, so the current entry always wins with the accent + weight 600.
    const active = rule('readerTocItem\\[aria-current="true"\\]');
    expect(active).toMatch(/color:\s*var\(--color-accent\)/u);
    expect(active).toMatch(/font-weight:\s*600/u);
    expect(block(".readerTocEntry")).toMatch(/color:\s*var\(--toc-entry-color\)/u);
  });

  it("uses a cheap 0.75rem indent step capped at depth 3", () => {
    expect(block(".readerTocNode")).toMatch(/--toc-indent-step:\s*0\.75rem/u);
    // The row inset caps the depth multiplier at 3 (max 2.25rem) so deep subsections stay readable.
    expect(block(".readerTocRow")).toMatch(
      /padding-inline-start:\s*calc\(\s*min\(\s*var\(--toc-depth,\s*0\),\s*3\)\s*\*\s*var\(--toc-indent-step/u
    );
  });

  it("clamps a label to at most two lines and reserves the full text via title (component)", () => {
    const label = block(".readerTocLabel");
    expect(label).toMatch(/-webkit-line-clamp:\s*2/u);
    expect(label).toMatch(/line-clamp:\s*2/u);
    expect(label).toMatch(/line-height:\s*1\.3/u);
    expect(label).toMatch(/overflow:\s*hidden/u);
  });

  it("shrinks the disclosure's reserved column while keeping its 44px hit target", () => {
    const disclosure = rule("readerTocDisclosure");
    // The 44px target is preserved (asserted in #476 too) but the control overhangs rather than
    // reserving a full 44px inline column, so the label reclaims the space.
    expect(disclosure).toMatch(/min-inline-size:\s*44px/u);
    expect(disclosure).toMatch(/margin-inline-end:\s*-1\.25rem/u);
    // The leaf spacer shrinks to the caret's compact visual width, not a full 44px.
    expect(rule("readerTocDisclosureSpacer")).toMatch(/min-inline-size:\s*1\.5rem/u);
  });

  it("widens the desktop drawer while mobile stays full-width", () => {
    expect(block(".readerToc--open .readerTocNav")).toMatch(/width:\s*min\(20rem,\s*85vw\)/u);
    // The mobile override (inside the max-width media query) still forces full width.
    expect(css).toMatch(/@media\s*\(max-width:\s*55\.999rem\)[^@]*width:\s*100%/u);
  });
});
