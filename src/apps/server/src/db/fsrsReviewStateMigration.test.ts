import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression for #572 review feedback: 0037 adds NOT NULL FSRS columns and then drops the SM-2
// columns. `ALTER TABLE ... ADD COLUMN ... NOT NULL` is rejected by PostgreSQL/PGlite on a non-empty
// table with no default, so the migration must be runnable against a local DB that already holds
// SM-2-era recall data. There is no SM-2 data migration (no real user data), so 0037 clears the old
// recall history and items first. This proves the transition runs against a populated table and wipes
// the incompatible rows — without the leading DELETEs, applying 0037 here throws.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0037_fsrs_review_state.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0037 (SM-2) shape of just the columns 0037 touches, so the migration's ADD/DROP apply.
async function seedSm2RecallData(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE recall_items (
      id text PRIMARY KEY,
      ease_factor double precision NOT NULL,
      interval_days integer NOT NULL,
      repetitions integer NOT NULL
    );
    CREATE TABLE recall_reviews (
      id text PRIMARY KEY,
      recall_item_id text NOT NULL,
      grade integer NOT NULL
    );
    INSERT INTO recall_items (id, ease_factor, interval_days, repetitions)
      VALUES ('item-sm2', 2.5, 1, 3);
    INSERT INTO recall_reviews (id, recall_item_id, grade)
      VALUES ('review-sm2', 'item-sm2', 4);
  `);
}

describe("0037 FSRS review-state migration", () => {
  it("runs against a populated SM-2 recall store, clearing rows before adding NOT NULL columns", async () => {
    const pglite = new PGlite();
    await seedSm2RecallData(pglite);

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const items = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM recall_items"
    );
    const reviews = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM recall_reviews"
    );
    expect(items.rows[0]?.count).toBe(0);
    expect(reviews.rows[0]?.count).toBe(0);

    // The new FSRS state is now insertable as NOT NULL (the SM-2 columns are gone).
    await expect(
      pglite.exec(`
        INSERT INTO recall_items
          (id, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, state)
          VALUES ('item-fsrs', 1.5, 5.0, 0, 0, 0, 0, 'new');
        INSERT INTO recall_reviews (id, recall_item_id, rating)
          VALUES ('review-fsrs', 'item-fsrs', 'good');
      `)
    ).resolves.toBeDefined();
  });
});
