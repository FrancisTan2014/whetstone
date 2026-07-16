import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The rigid Recitation curriculum — phase choice, passage division/introduction, chaining, support fading,
// and the hub session — is retired (#643). This is a repository-search guard: the shipped web source must
// no longer surface any of its user-facing labels or entry points, and its modules must be gone. If a
// retired label or file reappears, this test fails, so the removal cannot silently regress.

const webSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Distinctive user-facing strings from the retired flow. Each is specific enough not to collide with
// unrelated copy (e.g. "Optional chaining" in a comment), so a match means a retired surface came back.
const retiredLabels: readonly string[] = [
  "Divide into passages",
  "Start first passage",
  "Start next passage",
  "Start a new passage",
  "Skip new passage",
  "Recitation session",
  "Start session",
  "Introduce next",
  "introduce-next",
  "passages/seed",
  "Familiarizing",
  "Practise recitation",
  "support fading",
  "Continue the chain",
  "Starting phase"
];

// Retired modules that must no longer exist anywhere under the web source tree.
const retiredModules: readonly string[] = [
  "RecitationHubPage.tsx",
  "RecitationSessionPanel.tsx",
  "RecitationChainingPanel.tsx",
  "RecitePage.tsx",
  "recitationChainingApi.ts",
  "recitationHubApi.ts",
  "recitationPassageApi.ts",
  "recitationSessionApi.ts",
  "recitationFade.tokens.ts",
  "recitationLabels.ts"
];

function collectSourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    found.push(full);
  }
  return found;
}

describe("retired Recitation flow is gone from the shipped web UI (#643)", () => {
  const sourceFiles = collectSourceFiles(webSrcRoot);

  it("scans a non-empty set of shipped source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(retiredLabels)("no shipped source contains the retired label %j", (label) => {
    const offenders = sourceFiles.filter((file) => readFileSync(file, "utf8").includes(label));
    expect(offenders, `retired label "${label}" found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it.each(retiredModules)("retired module %s no longer exists", (moduleName) => {
    const present = sourceFiles.some((file) => file.endsWith(moduleName));
    expect(present, `retired module "${moduleName}" still exists`).toBe(false);
  });
});
