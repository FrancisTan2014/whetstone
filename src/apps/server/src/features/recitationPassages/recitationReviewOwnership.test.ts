import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #618: Recitation's scheduling was moved onto the shared review-card substrate (#617), which is now the
// SINGLE owner of FSRS mechanics. Recitation must read a card's schedule through the substrate's query
// mapper (`reviewStateFromCard`) and drive transitions through its command boundary — it must never
// re-implement card mutation or map card columns itself. This structural guard reads every Recitation
// feature source module and asserts none pulls in the FSRS transition vocabulary (`applyRating(`,
// `newReviewState`), the substrate's own column mapper (`reviewStateColumns`), or the deleted inline
// Recitation mappers (`passageReviewStateColumns`, `passageRowToReviewState`). Reading a card via
// `reviewStateFromCard` and composing through the substrate primitive `applyRatingToCardInTx` are
// allowed; only the pure domain transition, seeding, and column-mapping logic is forbidden here.

const passagesDir = fileURLToPath(new URL(".", import.meta.url));
const recitationDir = fileURLToPath(new URL("../recitation/", import.meta.url));
const schemaPath = fileURLToPath(new URL("../../db/schema.ts", import.meta.url));

const forbidden = [
  "applyRating(",
  "newReviewState",
  "reviewStateColumns",
  "passageReviewStateColumns",
  "passageRowToReviewState"
] as const;

function sourceFiles(dir: string): ReadonlyArray<string> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${dir}${name}`);
}

function recitationSourceFiles(): ReadonlyArray<string> {
  return [...sourceFiles(passagesDir), ...sourceFiles(recitationDir)];
}

// The `pgTable(...)` body for one table, from its literal name to the following `export const`.
function tableSource(schema: string, tableName: string): string {
  const marker = `"${tableName}"`;
  const start = schema.indexOf(marker);
  expect(start, `schema must define table ${tableName}`).toBeGreaterThanOrEqual(0);
  const next = schema.indexOf("export const", start + marker.length);
  return schema.slice(start, next === -1 ? undefined : next);
}

describe("Recitation feature owns no card-transition logic (#618)", () => {
  it("has recitation source modules to scan", () => {
    expect(recitationSourceFiles().length).toBeGreaterThan(0);
  });

  for (const symbol of forbidden) {
    it(`no Recitation source module references ${symbol}`, () => {
      for (const file of recitationSourceFiles()) {
        const contents = readFileSync(file, "utf8");
        expect(contents, `${file} must not reference ${symbol}`).not.toContain(symbol);
      }
    });
  }

  // The passage and whole-Work rows carry no scheduling state anymore — that lives in their review_cards.
  // These FSRS/due column literals must be absent from both table definitions.
  const fsrsColumns = [
    "stability",
    "difficulty",
    "elapsed_days",
    "scheduled_days",
    "learning_steps",
    "reps",
    "lapses",
    "due_at",
    "last_reviewed_at"
  ] as const;

  for (const tableName of ["recitation_passages", "recitation_whole_work"] as const) {
    it(`${tableName} defines no inline FSRS/due columns`, () => {
      const schema = readFileSync(schemaPath, "utf8");
      const body = tableSource(schema, tableName);
      for (const column of fsrsColumns) {
        expect(body, `${tableName} must not define column ${column}`).not.toContain(`"${column}"`);
      }
    });
  }
});
