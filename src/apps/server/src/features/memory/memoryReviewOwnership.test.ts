import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #617: the shared review-card substrate is the SINGLE owner of scheduler mechanics. The Memory feature
// must read a card's schedule (through the query mapper) and drive transitions through the substrate's
// command boundary — it must never re-implement card mutation. This structural guard reads every Memory
// feature source module and asserts none pulls in the FSRS transition vocabulary (`applyRating`,
// `newReviewState`) or maps card columns itself (`reviewStateColumns`). Reading a card is fine; only
// mutation/seeding logic is forbidden here. Any drift back to inline scheduling in Memory fails this test.

const featureDir = fileURLToPath(new URL(".", import.meta.url));

const forbidden = ["applyRating", "newReviewState", "reviewStateColumns"] as const;

function sourceFiles(): ReadonlyArray<string> {
  return readdirSync(featureDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
  );
}

describe("Memory feature owns no card-transition logic (#617)", () => {
  it("has at least one source module to scan", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  for (const symbol of forbidden) {
    it(`no Memory source module references ${symbol}`, () => {
      for (const file of sourceFiles()) {
        const contents = readFileSync(new URL(file, import.meta.url), "utf8");
        expect(contents, `${file} must not reference ${symbol}`).not.toContain(symbol);
      }
    });
  }
});
