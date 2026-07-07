import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #517 is a pure CSS/token change and jsdom has no cascade/layout to observe, so this guards the
// treatment directly on the stylesheets: in-content links (live cross-references + footnote markers, and
// inert links) are distinguished by the reference COLOUR `--color-link`, with NO underline in any state,
// while `.noteMark` keeps its underline (the reserved annotation channel).
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
const theme = readFileSync(fileURLToPath(new URL("../../styles/theme.css", import.meta.url)), "utf8");

// The declaration body of the first rule whose selector starts with `selectorStart`.
function body(selectorStart: string): string {
  const escaped = selectorStart.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

const dayBlock = /@theme\s*\{([\s\S]*?)\n\}/u.exec(theme)?.[1] ?? "";
const nightBlock = /\.dark\s*\{([\s\S]*?)\n\}/u.exec(theme)?.[1] ?? "";

describe("reader link colour, not underline (#517)", () => {
  it("styles a live cross-reference by the reference colour with no underline", () => {
    const xref = body(".readerXref");
    expect(xref).toMatch(/color:\s*var\(--color-link\)/u);
    expect(xref).toMatch(/cursor:\s*pointer/u);
    expect(xref).not.toMatch(/text-decoration/u);
    expect(xref).not.toMatch(/underline/u);
  });

  it("deepens the colour and adds a wash on hover/focus, still with no underline", () => {
    const hover = body(".readerXref:hover");
    expect(hover).toMatch(/color:\s*var\(--color-link-hover\)/u);
    expect(hover).toMatch(
      /background:\s*color-mix\(\s*in oklch,\s*var\(--color-link\)\s*14%,\s*transparent\s*\)/u
    );
    expect(hover).toMatch(/border-radius:/u);
    expect(hover).not.toMatch(/underline/u);
  });

  it("gives an inert link the reference colour, non-interactive, with no underline", () => {
    const inert = body(".readerLink--inert");
    expect(inert).toMatch(/color:\s*var\(--color-link\)/u);
    expect(inert).toMatch(/cursor:\s*default/u);
    expect(inert).not.toMatch(/text-decoration/u);
    expect(inert).not.toMatch(/underline/u);
  });

  it("leaves the note mark underline unchanged (the reserved annotation channel)", () => {
    const noteMark = /\.noteMark\s*\{([^}]*)\}/u.exec(theme)?.[1] ?? "";
    expect(noteMark).toMatch(/text-decoration-line:\s*underline/u);
  });

  it("defines --color-link and --color-link-hover in both Day and Night", () => {
    for (const token of ["--color-link", "--color-link-hover"]) {
      expect(dayBlock, `${token} missing from Day`).toContain(`${token}:`);
      expect(nightBlock, `${token} missing from Night`).toContain(`${token}:`);
    }
  });
});
