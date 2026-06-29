import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// At <56rem the reader tools must dock as a bottom bar within the safe area (#183) — never a top bar
// that wraps above the fold (controls measured at negative y). Assert the real CSS: the mobile tools
// pin to the bottom edge, pad for env(safe-area-inset-bottom), and recede downward (positive Y), so a
// regression back to top-docking fails. The mobile .readingTools rule is identified by its bottom dock
// (the desktop rail rule centers vertically instead), so these checks are unambiguous.
const css = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

function rule(matcher: RegExp): string {
  return matcher.exec(css)?.[1] ?? "";
}

describe("mobile reader chrome", () => {
  it("docks the tools at the bottom within the safe area", () => {
    const tools = rule(/\.readingTools\s*\{([^}]*inset-block-end[^}]*)\}/u);
    expect(tools).toMatch(/inset-block-end:\s*0/u);
    expect(tools).toMatch(/inset-block-start:\s*auto/u);
    expect(tools).toMatch(/padding-block-end:\s*max\(0\.4rem,\s*env\(safe-area-inset-bottom\)\)/u);
  });

  it("recedes the bottom bar downward (off-screen), never above the fold", () => {
    const hidden = rule(
      /data-hidden="true"\]\s*\.readingTools\s*\{([^}]*translateY\(130%\)[^}]*)\}/u
    );
    expect(hidden).toMatch(/translateY\(130%\)/u);
    expect(hidden).not.toMatch(/translateY\(-/u);
  });
});
