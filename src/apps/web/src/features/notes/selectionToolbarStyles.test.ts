import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The reader selection toolbar target-size fix (#487) lives in CSS, and jsdom has no layout to observe
// it, so this guards the change on the stylesheet: every toolbar control must be a >=44px hit target. The
// toolbar springs in from scale 0.96, so the controls are sized to 46px (2.875rem) to stay >=44px through
// the entrance animation — they measured ~42.9px before. Reverting to 2.75rem (44px, which dips under 44px
// mid-scale) fails these assertions.
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("selection toolbar target-size CSS (#487)", () => {
  it("sizes the primary actions to stay >=44px through the entrance scale", () => {
    expect(rule("selectionToolbarAction")).toMatch(/min-height:\s*2\.875rem/u);
  });

  it("sizes the dismiss control to a >=44px square through the entrance scale", () => {
    const dismiss = rule("selectionToolbarDismiss");
    expect(dismiss).toMatch(/min-height:\s*2\.875rem/u);
    expect(dismiss).toMatch(/min-width:\s*2\.875rem/u);
  });
});
