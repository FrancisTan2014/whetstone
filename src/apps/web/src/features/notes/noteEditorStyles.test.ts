import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The note-editor target-size fix (#505) lives in CSS, and jsdom has no layout to observe it, so this
// guards the root-cause change directly on the stylesheet: the template pill buttons and the short-text
// answer input must each carry a >=44px hit target. They rendered ~29.5px and ~24px tall before.
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function rule(name: string): string {
  return new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("note editor target-size CSS (#505)", () => {
  it("gives each template pill a >=44px hit target with its label centered", () => {
    const template = rule("noteEditorTemplate");
    expect(template).toMatch(/min-block-size:\s*44px/u);
    expect(template).toMatch(/display:\s*inline-flex/u);
    expect(template).toMatch(/align-items:\s*center/u);
    expect(template).toMatch(/justify-content:\s*center/u);
  });

  it("gives the short-text answer input a >=44px hit target", () => {
    const input = /\.noteEditor\s+input\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
    expect(input).toMatch(/min-block-size:\s*44px/u);
  });
});
