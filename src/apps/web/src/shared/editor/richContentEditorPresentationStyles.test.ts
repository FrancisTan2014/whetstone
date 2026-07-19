import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The three shared-editor presentations size the body in CSS, and jsdom has no layout to observe it, so
// this guards them directly on the stylesheet. It is the fail-before/pass-after regression for the
// reported note Sheet (#677): the Reader and Notes-home note editors rendered at the 6rem quick-input
// (compact) height — barely a line or two — with no composition room. The fix is a semantic `workspace`
// presentation that reuses the compact surface but carries a composition-sized body; reverting a note
// editor to `compact`, dropping the workspace body clamps, or collapsing the shared bordered surface
// fails one of these assertions.
const css = readFileSync(fileURLToPath(new URL("../../styles/theme.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("rich content editor presentation sizing (#677)", () => {
  it("keeps the compact presentation a quick-input box (6rem)", () => {
    const compact = ruleBody(
      '.richContentEditor[data-presentation="compact"] .richContentEditorContent'
    );
    expect(compact).toMatch(/min-block-size:\s*6rem/u);
  });

  it("keeps the default (full) presentation the page-sized body (16rem)", () => {
    // The base rule with no presentation qualifier — the full-page authoring surface.
    const base = /^\.richContentEditorContent\s*\{([^}]*)\}/mu.exec(css)?.[1] ?? "";
    expect(base).toMatch(/min-block-size:\s*16rem/u);
  });

  it("gives the workspace presentation a composition-sized body on desktop/tablet", () => {
    const workspace = ruleBody(
      '.richContentEditor[data-presentation="workspace"] .richContentEditorContent'
    );
    // The composition band the note editors need — never the 6rem quick-input box.
    expect(workspace).toMatch(/min-block-size:\s*clamp\(16rem,\s*42dvh,\s*28rem\)/u);
    expect(workspace).not.toMatch(/\b6rem\b/u);
  });

  it("shortens the workspace body on narrow screens so the keyboard leaves room", () => {
    // The narrow clamp lives under the Sheet's own 48rem flip (side panel -> full-width bottom sheet).
    const narrow =
      /@media\s*\(max-width:\s*47\.999rem\)\s*\{\s*\.richContentEditor\[data-presentation="workspace"\]\s+\.richContentEditorContent\s*\{([^}]*)\}/u.exec(
        css
      )?.[1] ?? "";
    expect(narrow).toMatch(/min-block-size:\s*clamp\(12rem,\s*34dvh,\s*20rem\)/u);
  });

  it("reuses the compact bordered surface and focus ring for the workspace (one editor, not two)", () => {
    // Both presentations share the same bordered box + focus-within ring: the workspace is the compact
    // surface with a larger body, not a second editor. A workspace-only or compact-only surface fails.
    const surface =
      /\.richContentEditor\[data-presentation="compact"\],\s*\.richContentEditor\[data-presentation="workspace"\]\s*\{([^}]*)\}/u.exec(
        css
      )?.[1] ?? "";
    expect(surface).toMatch(/border:\s*1px solid var\(--color-border\)/u);
    expect(surface).toMatch(/background-color:\s*var\(--color-surface\)/u);

    const focusRing =
      /\.richContentEditor\[data-presentation="compact"\]:focus-within,\s*\.richContentEditor\[data-presentation="workspace"\]:focus-within\s*\{([^}]*)\}/u.exec(
        css
      )?.[1] ?? "";
    expect(focusRing).toMatch(/box-shadow:\s*0 0 0 2px var\(--color-ring\)/u);
  });
});
