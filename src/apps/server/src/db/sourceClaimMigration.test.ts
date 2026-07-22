import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #706 uploaded-source claims. Migration 0063 creates `uploaded_source_claims` and backfills one
// deterministic single-owner claim per distinct uploaded-source hash — only for imported Works'
// upload-kind bytes, and the lexicographically smallest Work id wins a shared hash. These tests
// hand-build the pre-migration schema and apply ONLY the new SQL file, proving the backfill's
// selection/dedup and that no existing Work, source, or content row is merged or deleted.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0063_steady_purifiers.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0063 subset the backfill reads: entries, authors, work_meta (with origin), and work_sources.
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
    CREATE TABLE work_sources (
      id text PRIMARY KEY,
      kind text NOT NULL,
      sha256 text NOT NULL,
      work_entry_id text NOT NULL REFERENCES entries(id)
    );
    INSERT INTO authors (id, name) VALUES ('author-1', 'Author');
  `);
}

async function seedWork(pglite: PGlite, entryId: string, origin: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.exec(
    `INSERT INTO work_meta (entry_id, author_id, language, origin, title, work_type)
     VALUES ('${entryId}', 'author-1', 'en', '${origin}', 'T', 'book');`
  );
}

async function seedSource(
  pglite: PGlite,
  id: string,
  workEntryId: string,
  kind: string,
  sha256: string
): Promise<void> {
  await pglite.exec(
    `INSERT INTO work_sources (id, kind, sha256, work_entry_id)
     VALUES ('${id}', '${kind}', '${sha256}', '${workEntryId}');`
  );
}

type ClaimRow = Readonly<{ sha256: string; work_entry_id: string }>;

async function readClaims(pglite: PGlite): Promise<ReadonlyArray<ClaimRow>> {
  const result = await pglite.query<ClaimRow>(
    `SELECT sha256, work_entry_id FROM uploaded_source_claims ORDER BY sha256;`
  );

  return result.rows;
}

describe("migration 0063: uploaded_source_claims backfill (#706)", () => {
  it("claims one deterministic owner per distinct imported upload hash, and nothing else", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // Two imported Works share "sha-dup"; work-b is inserted first, so a claim on "work-a" proves the
    // owner is chosen by MIN (lexicographically smallest id), not insertion order.
    await seedWork(pglite, "work-b", "imported");
    await seedWork(pglite, "work-a", "imported");
    await seedSource(pglite, "src-b", "work-b", "upload", "sha-dup");
    await seedSource(pglite, "src-a", "work-a", "upload", "sha-dup");

    // A solo imported upload gets its own claim.
    await seedWork(pglite, "work-c", "imported");
    await seedSource(pglite, "src-c", "work-c", "upload", "sha-solo");

    // A manual-kind source (authored text, not an upload) is never claimed.
    await seedWork(pglite, "work-d", "imported");
    await seedSource(pglite, "src-d", "work-d", "manual", "sha-manual");

    // A manual-origin Work's upload bytes are excluded by the origin filter.
    await seedWork(pglite, "work-e", "manual");
    await seedSource(pglite, "src-e", "work-e", "upload", "sha-manual-work");

    await applyMigrationFile(pglite);

    expect(await readClaims(pglite)).toEqual([
      { sha256: "sha-dup", work_entry_id: "work-a" },
      { sha256: "sha-solo", work_entry_id: "work-c" }
    ]);

    // Every original Work and source row is preserved — the backfill only inserts claims.
    const works = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM work_meta;`
    );
    const sources = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM work_sources;`
    );
    expect(works.rows[0]?.count).toBe(5);
    expect(sources.rows[0]?.count).toBe(5);

    await pglite.close();
  });

  it("enforces a single-owner claim per hash via the primary key and a valid Work reference", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedWork(pglite, "work-a", "imported");
    await seedSource(pglite, "src-a", "work-a", "upload", "sha-1");
    await applyMigrationFile(pglite);

    // A second claim for the same hash is refused by the primary key (one owner per hash).
    await expect(
      pglite.exec(
        `INSERT INTO uploaded_source_claims (sha256, work_entry_id) VALUES ('sha-1', 'work-a');`
      )
    ).rejects.toThrow();

    // A claim must reference an existing Work entry.
    await expect(
      pglite.exec(
        `INSERT INTO uploaded_source_claims (sha256, work_entry_id) VALUES ('sha-2', 'ghost');`
      )
    ).rejects.toThrow();

    await pglite.close();
  });

  it("creates an empty claims table when no uploaded imported sources exist", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await applyMigrationFile(pglite);

    expect(await readClaims(pglite)).toEqual([]);

    await pglite.close();
  });
});
