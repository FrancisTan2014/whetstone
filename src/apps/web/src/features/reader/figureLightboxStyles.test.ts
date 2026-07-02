import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The figure viewer's fit-to-viewport fix (#381) lives in CSS, and jsdom has no layout to observe it, so
// this guards the root-cause change directly on the stylesheet: `.lightbox-image` must FILL its fit box
// (so a small source scales UP), not merely cap at its intrinsic pixels via `max-*` (the old bug where a
// diagram narrower than the viewport never enlarged). Reverting to `max-*`-only sizing fails here.
const css = readFileSync(fileURLToPath(new URL("../../styles/theme.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("figure lightbox fit-to-viewport CSS (#381)", () => {
  it("fills the fit box so small sources scale up (not max-* only), preserving aspect", () => {
    const image = rule("lightbox-image");
    expect(image).toMatch(/inline-size:\s*100%/u);
    expect(image).toMatch(/block-size:\s*100%/u);
    expect(image).toMatch(/object-fit:\s*contain/u);
    expect(image).not.toMatch(/max-inline-size/u);
  });

  it("sizes the pan viewport to the viewport bounds and hands gestures to the viewer", () => {
    const viewport = rule("lightbox-viewport");
    expect(viewport).toMatch(/inline-size:\s*96vw/u);
    expect(viewport).toMatch(/block-size:\s*92vh/u);
    // touch-action:none so pinch/drag pan the image instead of scrolling/zooming the page.
    expect(viewport).toMatch(/touch-action:\s*none/u);
  });

  it("gives each zoom control a >=44px keyboard target", () => {
    const control = rule("lightbox-control");
    expect(control).toMatch(/min-inline-size:\s*44px/u);
    expect(control).toMatch(/min-block-size:\s*44px/u);
  });
});
