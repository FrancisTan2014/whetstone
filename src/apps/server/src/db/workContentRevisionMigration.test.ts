import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #703 Work-scoped content revision. Migration 0073 adds `work_meta.content_revision` — the origin-neutral
// optimistic-concurrency token — as a NON-NULL integer defaulting to 0, guarded by a CHECK (>= 0). These
// tests hand-build the pre-migration schema (work_meta WITHOUT the column) and apply ONLY the new SQL file,
// so they exercise the real backfill default, the CHECK constraint, and id preservation in isolation.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0073_work_content_revision.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0073 subset the migration touches: work_meta WITHOUT `content_revision`.
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
      work_type text NOT NULL
    );
    INSERT INTO authors (id, name) VALUES ('author-1', 'Author');
  `);
}

async function seedWork(pglite: PGlite, entryId: string, origin: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.exec(
    `INSERT INTO work_meta (entry_id, author_id, language, origin, title, work_type)
     VALUES ('${entryId}', 'author-1', 'en', '${origin}', '${entryId}', 'book');`
  );
}

async function revisions(pglite: PGlite): Promise<Map<string, number>> {
  const rows = await pglite.query<{ entry_id: string; content_revision: number }>(
    "SELECT entry_id, content_revision FROM work_meta ORDER BY entry_id"
  );
  return new Map(rows.rows.map((row) => [row.entry_id, row.content_revision]));
}

describe("0073 work content revision migration", () => {
  it("backfills every existing Work to revision 0 while preserving ids", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    await seedWork(pglite, "manual-work", "manual");
    await seedWork(pglite, "imported-work", "imported");
    await seedWork(pglite, "authored-work", "authored");

    await applyMigrationFile(pglite);

    // Every pre-existing Work, regardless of origin, is backfilled to the default 0 — the same starting
    // token an editable-origin save will compare-and-set against.
    const resolved = await revisions(pglite);
    expect(resolved.get("manual-work")).toBe(0);
    expect(resolved.get("imported-work")).toBe(0);
    expect(resolved.get("authored-work")).toBe(0);

    // No row was added or dropped: the migration only adds a column, it never re-keys a Work.
    const count = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_meta"
    );
    expect(count.rows[0]?.count).toBe(3);
  });

  it("defaults a newly inserted Work to revision 0", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await applyMigrationFile(pglite);

    await seedWork(pglite, "fresh-work", "imported");

    const resolved = await revisions(pglite);
    expect(resolved.get("fresh-work")).toBe(0);
  });

  it("rejects a negative content revision via the CHECK constraint", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await applyMigrationFile(pglite);

    await pglite.exec(`INSERT INTO entries (id, type) VALUES ('bad', 'work');`);
    await expect(
      pglite.exec(
        `INSERT INTO work_meta (entry_id, author_id, language, origin, title, work_type, content_revision)
         VALUES ('bad', 'author-1', 'en', 'manual', 'Bad', 'book', -1);`
      )
    ).rejects.toThrow();
  });
});
