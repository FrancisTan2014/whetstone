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

const theme = readFileSync(fileURLToPath(new URL("./styles/theme.css", import.meta.url)), "utf8");
const dayBlock = /@theme\s*\{([\s\S]*?)\n\}/u.exec(theme)?.[1] ?? "";
const nightBlock = /\.dark\s*\{([\s\S]*?)\n\}/u.exec(theme)?.[1] ?? "";

describe("styles.css", () => {
  it("uses semantic tokens, not raw hex colors, so panels flip with Day/Night", () => {
    const hexLiterals = css.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
    expect(hexLiterals).toEqual([]);
  });

  it("references only theme tokens that resolve in both Day and Night", () => {
    // The note-template/chip swatches set --hue-wash to a --color-anno-*-wash token; if that token is
    // undefined, the chip background goes transparent (#248 regression). Assert every --color-* token
    // styles.css references is actually defined in both the Day (@theme) and Night (.dark) blocks.
    const referenced = [...css.matchAll(/var\((--color-[\w-]+)/gu)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const token of new Set(referenced)) {
      expect(dayBlock, `${token} missing from Day`).toContain(`${token}:`);
      expect(nightBlock, `${token} missing from Night`).toContain(`${token}:`);
    }
  });
});
