import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// styles.css is legacy: it hardcoded light hex for fills/text, so panels washed out in Night (#248).
// Colors must come from the Day/Night semantic tokens, so this guards against any raw hex creeping
// back — reverting any migrated panel to a hex literal fails. Comments (issue refs like "#187") are
// stripped first; shadows/backdrops use rgb() and carry no hex, so the file should hold none at all.
const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//gu,
  ""
);

describe("styles.css", () => {
  it("uses semantic tokens, not raw hex colors, so panels flip with Day/Night", () => {
    const hexLiterals = css.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
    expect(hexLiterals).toEqual([]);
  });
});
