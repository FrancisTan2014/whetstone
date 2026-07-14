import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

// Regression for #606: 0047 adds the learner's `timezone` column to `reader_preferences`. It is nullable
// by design — a row created before this migration (or before the client's first-use defaulting persists a
// zone) has no zone yet, and a null is the signal the client uses to send the browser's zone exactly
// once. This proves the migration adds the column without dropping or defaulting existing rows, so a
// saved reading size / theme survives and its zone starts null rather than being reinterpreted.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0047_silent_jackpot.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0047 shape of `reader_preferences` (no `timezone`), holding one saved record.
async function seedPreferences(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE reader_preferences (
      reading_size text NOT NULL,
      theme text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      user_id text PRIMARY KEY
    );
    INSERT INTO reader_preferences (reading_size, theme, user_id)
    VALUES ('lg', 'night', 'user-1');
  `);
}

describe("0047 reader preferences timezone migration", () => {
  it("adds a nullable timezone column, preserving existing rows with a null zone", async () => {
    const pglite = new PGlite();
    await seedPreferences(pglite);

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const rows = await pglite.query<{
      reading_size: string;
      theme: string;
      timezone: string | null;
      user_id: string;
    }>(`SELECT user_id, reading_size, theme, timezone FROM reader_preferences`);
    expect(rows.rows).toEqual([
      { reading_size: "lg", theme: "night", timezone: null, user_id: "user-1" }
    ]);
  });

  it("lets a later save store a concrete IANA zone in the new column", async () => {
    const pglite = new PGlite();
    await seedPreferences(pglite);
    await applyMigrationFile(pglite);

    await pglite.exec(
      `UPDATE reader_preferences SET timezone = 'America/New_York' WHERE user_id = 'user-1'`
    );
    const rows = await pglite.query<{ timezone: string | null }>(
      `SELECT timezone FROM reader_preferences WHERE user_id = 'user-1'`
    );
    expect(rows.rows[0]?.timezone).toBe("America/New_York");
  });

  it("applies the whole chain against a fresh database, ending with the timezone column present", async () => {
    const pglite = new PGlite();
    await expect(runMigrations(pglite)).resolves.toBeUndefined();

    const result = await pglite.query<{ exists: boolean }>(
      `SELECT count(*) > 0 AS exists FROM information_schema.columns
         WHERE table_name = 'reader_preferences' AND column_name = 'timezone'`
    );
    expect(result.rows[0]?.exists).toBe(true);
  });
});
