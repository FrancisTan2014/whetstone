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
