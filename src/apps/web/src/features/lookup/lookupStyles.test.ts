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
