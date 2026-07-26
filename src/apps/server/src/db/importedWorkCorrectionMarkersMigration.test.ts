import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #762 imported-Work correction markers. Migration 0079 adds two nullable correction markers:
// `work_meta.manual_corrections_at` (the Work-level "first corrected" instant) and
// `doc_blocks.corrected_at` (the per-block "changed/inserted by a correction" instant). Both are additive,
// nullable, and default to NULL so every pre-existing Work and block is preserved as "never corrected".
// These tests hand-build the pre-migration subset (the tables WITHOUT the new columns) and apply ONLY the
// new SQL file, so they exercise the real additive defaults, id/value preservation, and a backup/restore
// round-trip in isolation.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0079_imported_work_correction_markers.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0079 subset the migration touches: work_meta WITHOUT `manual_corrections_at` and doc_blocks
// WITHOUT `corrected_at`. Both already carry the #703 `content_revision`.
async function createPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE authors (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE work_meta (
      author_id text NOT NULL REFERENCES authors(id),
      entry_id text PRIMARY KEY REFERENCES entries(id),
      language text NOT NULL,
      origin text NOT NULL,
      title text NOT NULL,
      work_type text NOT NULL,
      content_revision integer NOT NULL DEFAULT 0
    );
    CREATE TABLE doc_blocks (
      anchor_id text,
      anchors jsonb NOT NULL DEFAULT '[]'::jsonb,
      id text PRIMARY KEY REFERENCES entries(id),
      node_json jsonb NOT NULL,
      order_index integer NOT NULL,
      plaintext text NOT NULL,
      reading_unit_entry_id text NOT NULL,
      type text NOT NULL,
      work_entry_id text NOT NULL
    );
    INSERT INTO authors (id, name) VALUES ('author-1', 'Author');
  `);
}

async function seedWork(pglite: PGlite, entryId: string, origin: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.exec(
    `INSERT INTO work_meta (entry_id, author_id, language, origin, title, work_type, content_revision)
     VALUES ('${entryId}', 'author-1', 'en', '${origin}', '${entryId}', 'book', 3);`
  );
}

async function seedBlock(pglite: PGlite, id: string, workEntryId: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${id}', 'block');`);
  await pglite.exec(
    `INSERT INTO doc_blocks (id, node_json, order_index, plaintext, reading_unit_entry_id, type, work_entry_id)
     VALUES ('${id}', '{"type":"paragraph"}'::jsonb, 0, 'text', 'unit-1', 'paragraph', '${workEntryId}');`
  );
}

describe("0079 imported-Work correction markers migration", () => {
  it("adds both markers as NULL for every existing Work and block while preserving them", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    await seedWork(pglite, "imported-work", "imported");
    await seedWork(pglite, "manual-work", "manual");
    await seedBlock(pglite, "block-1", "imported-work");

    await applyMigrationFile(pglite);

    // Every pre-existing Work is preserved (id, revision) and defaults to "never corrected".
    const works = await pglite.query<{
      content_revision: number;
      entry_id: string;
      manual_corrections_at: Date | null;
    }>("SELECT entry_id, content_revision, manual_corrections_at FROM work_meta ORDER BY entry_id");
    expect(works.rows).toEqual([
      { content_revision: 3, entry_id: "imported-work", manual_corrections_at: null },
      { content_revision: 3, entry_id: "manual-work", manual_corrections_at: null }
    ]);

    const blocks = await pglite.query<{ corrected_at: Date | null; id: string }>(
      "SELECT id, corrected_at FROM doc_blocks ORDER BY id"
    );
    expect(blocks.rows).toEqual([{ corrected_at: null, id: "block-1" }]);
  });

  it("accepts a correction instant on both markers after the migration", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedWork(pglite, "imported-work", "imported");
    await seedBlock(pglite, "block-1", "imported-work");
    await applyMigrationFile(pglite);

    const stamped = new Date("2026-02-01T12:00:00.000Z");
    await pglite.query("UPDATE work_meta SET manual_corrections_at = $1 WHERE entry_id = $2", [
      stamped,
      "imported-work"
    ]);
    await pglite.query("UPDATE doc_blocks SET corrected_at = $1 WHERE id = $2", [
      stamped,
      "block-1"
    ]);

    const work = await pglite.query<{ manual_corrections_at: Date | null }>(
      "SELECT manual_corrections_at FROM work_meta WHERE entry_id = 'imported-work'"
    );
    const block = await pglite.query<{ corrected_at: Date | null }>(
      "SELECT corrected_at FROM doc_blocks WHERE id = 'block-1'"
    );
    expect(work.rows[0]?.manual_corrections_at?.toISOString()).toBe(stamped.toISOString());
    expect(block.rows[0]?.corrected_at?.toISOString()).toBe(stamped.toISOString());
  });

  it("round-trips the markers through a backup/restore of the migrated shape", async () => {
    const source = new PGlite();
    await createPreMigrationSchema(source);
    await seedWork(source, "imported-work", "imported");
    await seedBlock(source, "block-1", "imported-work");
    await applyMigrationFile(source);

    const stamped = new Date("2026-03-03T08:30:00.000Z");
    await source.query("UPDATE work_meta SET manual_corrections_at = $1 WHERE entry_id = $2", [
      stamped,
      "imported-work"
    ]);
    await source.query("UPDATE doc_blocks SET corrected_at = $1 WHERE id = $2", [
      stamped,
      "block-1"
    ]);

    // A restore rebuilds the migrated schema and re-inserts the dumped rows including the new columns.
    const restored = new PGlite();
    await createPreMigrationSchema(restored);
    await applyMigrationFile(restored);
    await restored.exec("INSERT INTO entries (id, type) VALUES ('imported-work', 'work');");
    await restored.exec("INSERT INTO entries (id, type) VALUES ('block-1', 'block');");
    await restored.query(
      `INSERT INTO work_meta (entry_id, author_id, language, origin, title, work_type, content_revision, manual_corrections_at)
       VALUES ('imported-work', 'author-1', 'en', 'imported', 'imported-work', 'book', 3, $1)`,
      [stamped]
    );
    await restored.query(
      `INSERT INTO doc_blocks (id, node_json, order_index, plaintext, reading_unit_entry_id, type, work_entry_id, corrected_at)
       VALUES ('block-1', '{"type":"paragraph"}'::jsonb, 0, 'text', 'unit-1', 'paragraph', 'imported-work', $1)`,
      [stamped]
    );

    const work = await restored.query<{ manual_corrections_at: Date | null }>(
      "SELECT manual_corrections_at FROM work_meta WHERE entry_id = 'imported-work'"
    );
    const block = await restored.query<{ corrected_at: Date | null }>(
      "SELECT corrected_at FROM doc_blocks WHERE id = 'block-1'"
    );
    expect(work.rows[0]?.manual_corrections_at?.toISOString()).toBe(stamped.toISOString());
    expect(block.rows[0]?.corrected_at?.toISOString()).toBe(stamped.toISOString());
  });
});
