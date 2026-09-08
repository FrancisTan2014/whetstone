import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The Explain feature's own action control (#924/#925) must carry a >=44px hit target in both
// dimensions (WCAG 2.5.5), same as the rest of the lookup panel's controls. jsdom has no layout, so
// this guards the root-cause change directly on the stylesheet.
const css = readFileSync(fileURLToPath(new URL("../../../styles.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("explain action button target CSS (#925)", () => {
  it("gives the action/retry button a >=44px hit target in both dimensions", () => {
    const button = rule("explainActionButton");
    expect(button).toMatch(/min-inline-size:\s*44px/u);
    expect(button).toMatch(/min-block-size:\s*44px/u);
  });

  it("centers the label in the target", () => {
    const button = rule("explainActionButton");
    expect(button).toMatch(/display:\s*inline-flex/u);
    expect(button).toMatch(/align-items:\s*center/u);
    expect(button).toMatch(/justify-content:\s*center/u);
  });
});

describe("explain map tokenization (#925)", () => {
  it("marks the current family/branch with semantic accent tokens, not a hardcoded color", () => {
    expect(rule("explainFamily.explainFamilyCurrent")).toMatch(/var\(--color-accent\)/u);
    expect(rule("explainBranch.explainBranchCurrent")).toMatch(/var\(--color-accent\)/u);
    expect(rule("explainCurrentMarker")).toMatch(/var\(--color-accent\)/u);
  });

  it("renders every text color from a semantic token so Day/Night both apply", () => {
    for (const name of [
      "explainCoreImage",
      "explainBranchLabel",
      "explainBranchConnection",
      "explainBranchExample",
      "explainProvider",
      "explainError"
    ]) {
      expect(rule(name)).toMatch(/var\(--color-/u);
    }
  });
});
