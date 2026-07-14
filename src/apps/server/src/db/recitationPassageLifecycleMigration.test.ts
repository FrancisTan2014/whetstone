import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

// Regression for #605: 0046 introduces the passage lifecycle (queued vs active). It makes the FSRS
// columns nullable, adds `introduced_at`, and enforces `recitation_passages_lifecycle_ck` — but every
// passage created before this migration is an active, fully-scheduled card whose `introduced_at` starts
// null. The check constraint's active branch demands `introduced_at is not null`, so without the
// backfill UPDATE that runs *between* ADD COLUMN and ADD CONSTRAINT, applying 0046 against a populated
// table throws. This proves the migration preserves existing passages' history instead of rejecting it.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0046_lively_sunspot.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0046 shape of just the columns 0046 touches (FSRS all NOT NULL, no `introduced_at`), holding
// two active passages: one reviewed (last_reviewed_at set) and one freshly seeded (last_reviewed_at
// null), so the backfill and constraint are exercised for both.
async function seedActivePassages(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE recitation_passages (
      entry_id text PRIMARY KEY,
      created_at timestamptz NOT NULL,
      last_reviewed_at timestamptz,
      stability double precision NOT NULL,
      difficulty double precision NOT NULL,
      elapsed_days integer NOT NULL,
      scheduled_days integer NOT NULL,
      learning_steps integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      state text NOT NULL,
      due_at timestamptz NOT NULL
    );
    INSERT INTO recitation_passages
      (entry_id, created_at, last_reviewed_at, stability, difficulty, elapsed_days,
       scheduled_days, learning_steps, reps, lapses, state, due_at)
    VALUES
      ('passage-reviewed', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z',
       2.5, 5.0, 4, 4, 0, 3, 1, 'review', '2026-01-10T00:00:00Z'),
      ('passage-fresh', '2026-02-01T00:00:00Z', NULL,
       1.5, 5.0, 0, 0, 0, 0, 0, 'new', '2026-02-01T00:00:00Z');
  `);
}

describe("0046 recitation passage lifecycle migration", () => {
  it("backfills introduced_at from created_at so existing active passages satisfy the check constraint", async () => {
    const pglite = new PGlite();
    await seedActivePassages(pglite);

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const rows = await pglite.query<{ entry_id: string; introduced_matches: boolean }>(
      `SELECT entry_id, introduced_at = created_at AS introduced_matches
         FROM recitation_passages ORDER BY entry_id`
    );
    expect(rows.rows).toEqual([
      { entry_id: "passage-fresh", introduced_matches: true },
      { entry_id: "passage-reviewed", introduced_matches: true }
    ]);
  });

  it("enforces the lifecycle constraint: a queued (all-null) row is allowed, a partial one is rejected", async () => {
    const pglite = new PGlite();
    await seedActivePassages(pglite);
    await applyMigrationFile(pglite);

    // A queued passage: introduced_at and every FSRS field null.
    await expect(
      pglite.exec(`
        INSERT INTO recitation_passages
          (entry_id, created_at, last_reviewed_at, stability, difficulty, elapsed_days,
           scheduled_days, learning_steps, reps, lapses, state, due_at, introduced_at)
        VALUES ('passage-queued', '2026-03-01T00:00:00Z', NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL);
      `)
    ).resolves.toBeDefined();

    // A half-scheduled row (introduced but missing FSRS fields) violates both branches.
    await expect(
      pglite.exec(`
        INSERT INTO recitation_passages
          (entry_id, created_at, last_reviewed_at, stability, difficulty, elapsed_days,
           scheduled_days, learning_steps, reps, lapses, state, due_at, introduced_at)
        VALUES ('passage-broken', '2026-03-02T00:00:00Z', NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, '2026-03-02T00:00:00Z');
      `)
    ).rejects.toThrow();
  });

  it("applies the whole chain against a fresh database, ending with the lifecycle constraint present", async () => {
    const pglite = new PGlite();
    await expect(runMigrations(pglite)).resolves.toBeUndefined();

    const result = await pglite.query<{ exists: boolean }>(
      `SELECT count(*) > 0 AS exists FROM pg_constraint
         WHERE conname = 'recitation_passages_lifecycle_ck'`
    );
    expect(result.rows[0]?.exists).toBe(true);
  });
});
