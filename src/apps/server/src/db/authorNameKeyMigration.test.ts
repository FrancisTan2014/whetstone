import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #694 canonical author identity. The migration adds `authors.name_key`, defines the shared
// `clean_author_name` / `author_name_key` SQL functions, deduplicates named authors onto one
// deterministic survivor without losing a Work, and protects the key with a partial unique index.
// These tests hand-build the pre-migration schema (authors had no `name_key`) and apply ONLY the new
// SQL file, so they exercise the real merge logic in isolation.

// A full-width (ideographic) space — a real name-key collision case NFKC folds to a plain space.
// Interpolated instead of written literally so `no-irregular-whitespace` stays clean.
const IDEO = "\u3000";

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0058_green_nomad.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0058 subset the migration reads and rewrites: authors WITHOUT `name_key`, plus the
// work_meta FK edge the survivor selection and orphan guard depend on.
async function createPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE authors (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE work_meta (
      author_id text NOT NULL REFERENCES authors(id),
      entry_id text PRIMARY KEY REFERENCES entries(id),
      language text NOT NULL,
      title text NOT NULL,
      work_type text NOT NULL
    );
  `);
}

async function seedWork(pglite: PGlite, entryId: string, authorId: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.exec(
    `INSERT INTO work_meta (entry_id, author_id, language, title, work_type)
     VALUES ('${entryId}', '${authorId}', 'en', '${entryId}', 'book');`
  );
}

describe("0058 canonical author identity migration", () => {
  it("cleans and keys names, merges duplicates deterministically, and preserves every Work", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // 诸葛亮 group: the whitespace variant (`zge-a`) has the lexicographically smaller id but fewer
    // Works, so the most-referenced row (`zge-b`, 2 Works) must win despite the larger id.
    await pglite.exec(`
      INSERT INTO authors (id, name) VALUES
        ('zge-b', '诸葛亮'),
        ('zge-a', ' 诸葛亮 ');
    `);
    await seedWork(pglite, "w1", "zge-b");
    await seedWork(pglite, "w2", "zge-b");
    await seedWork(pglite, "w3", "zge-a");

    // Octavia group: case + full-width-space variants tie on Work count (1 each), so the smaller id
    // (`oct-1`) wins, and its cleaned display name is the survivor's `name`.
    await pglite.exec(`
      INSERT INTO authors (id, name) VALUES
        ('oct-2', 'Octavia Butler'),
        ('oct-1', ' octavia${IDEO}butler ');
    `);
    await seedWork(pglite, "w4", "oct-2");
    await seedWork(pglite, "w5", "oct-1");

    // A lone author with collapsible internal whitespace: no duplicate, just cleaned + keyed.
    await pglite.exec(`INSERT INTO authors (id, name) VALUES ('kle-1', '  Martin   Kleppmann  ');`);
    await seedWork(pglite, "w6", "kle-1");

    // Two owner-keyed "You" identities with identical display names must NEVER merge.
    await pglite.exec(`
      INSERT INTO authors (id, name) VALUES
        ('self-author:user-1', 'You'),
        ('self-author:user-2', 'You');
    `);
    await seedWork(pglite, "w7", "self-author:user-1");
    await seedWork(pglite, "w8", "self-author:user-2");

    await applyMigrationFile(pglite);

    // Every Work survives and still points at a real author (no orphan).
    const orphan = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM work_meta wm
       LEFT JOIN authors a ON a.id = wm.author_id WHERE a.id IS NULL`
    );
    expect(orphan.rows[0]?.count).toBe(0);
    const workCount = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_meta"
    );
    expect(workCount.rows[0]?.count).toBe(8);

    // Duplicates collapsed: 诸葛亮 (1) + octavia (1) + kleppmann (1) + 2 self = 5 rows.
    const authors = await pglite.query<{ id: string; name: string; name_key: string | null }>(
      "SELECT id, name, name_key FROM authors ORDER BY id"
    );
    expect(authors.rows.map((row) => row.id)).toEqual([
      "kle-1",
      "oct-1",
      "self-author:user-1",
      "self-author:user-2",
      "zge-b"
    ]);

    const byId = new Map(authors.rows.map((row) => [row.id, row]));
    // Most-Works survivor kept, whitespace variant merged into it, display name cleaned.
    expect(byId.get("zge-b")).toEqual({ id: "zge-b", name: "诸葛亮", name_key: "诸葛亮" });
    // Tie broken by smallest id; survivor carries its own cleaned (lowercase) display name.
    expect(byId.get("oct-1")).toEqual({
      id: "oct-1",
      name: "octavia butler",
      name_key: "octavia butler"
    });
    expect(byId.get("kle-1")).toEqual({
      id: "kle-1",
      name: "Martin Kleppmann",
      name_key: "martin kleppmann"
    });
    // Self-author rows keep NULL keys and are never merged.
    expect(byId.get("self-author:user-1")?.name_key).toBeNull();
    expect(byId.get("self-author:user-2")?.name_key).toBeNull();

    // Works repointed onto survivors.
    const worksByAuthor = await pglite.query<{ author_id: string; count: number }>(
      "SELECT author_id, count(*)::int AS count FROM work_meta GROUP BY author_id ORDER BY author_id"
    );
    const workCounts = new Map(worksByAuthor.rows.map((row) => [row.author_id, row.count]));
    expect(workCounts.get("zge-b")).toBe(3);
    expect(workCounts.get("oct-1")).toBe(2);
    expect(workCounts.get("kle-1")).toBe(1);
  });

  it("enforces the canonical key with a partial unique index that still allows many NULL keys", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await pglite.exec(`INSERT INTO authors (id, name) VALUES ('a-1', 'Ann Leckie');`);

    await applyMigrationFile(pglite);

    // A second row whose cleaned/keyed name collides (case + width variant) is rejected by the index.
    await expect(
      pglite.exec(
        `INSERT INTO authors (id, name, name_key)
         VALUES ('a-2', clean_author_name(' ANN${IDEO}LECKIE '), author_name_key(' ANN${IDEO}LECKIE '));`
      )
    ).rejects.toThrow();

    // The partial index only covers non-NULL keys, so any number of self-author "You" rows coexist.
    await pglite.exec(`
      INSERT INTO authors (id, name, name_key) VALUES
        ('self-author:user-3', 'You', NULL),
        ('self-author:user-4', 'You', NULL);
    `);
    const nulls = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM authors WHERE name_key IS NULL"
    );
    expect(nulls.rows[0]?.count).toBe(2);
  });

  it("aborts atomically on blank legacy data, leaving no partial mutation", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    // A legacy name that is blank after cleaning (only ideographic spaces) must abort the migration.
    await pglite.exec(`
      INSERT INTO authors (id, name) VALUES
        ('good-1', '  Real   Name  '),
        ('blank-1', '${IDEO}${IDEO}');
    `);
    await seedWork(pglite, "w1", "good-1");
    await seedWork(pglite, "w2", "blank-1");

    await expect(applyMigrationFile(pglite)).rejects.toThrow();

    // The column was added, but the DO block rolled back: no name cleaned, no key backfilled, no merge.
    const rows = await pglite.query<{ id: string; name: string; name_key: string | null }>(
      "SELECT id, name, name_key FROM authors ORDER BY id"
    );
    expect(rows.rows).toEqual([
      { id: "blank-1", name: "　　", name_key: null },
      { id: "good-1", name: "  Real   Name  ", name_key: null }
    ]);
    const workCount = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_meta"
    );
    expect(workCount.rows[0]?.count).toBe(2);
  });
});
