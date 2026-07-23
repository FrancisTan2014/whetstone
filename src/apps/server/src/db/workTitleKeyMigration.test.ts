import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #724 canonical Work duplicate-candidate key. The migration defines the shared `work_title_key` SQL
// function and adds `work_meta.title_key` as a GENERATED STORED column, so PostgreSQL keys every Work from
// its display title on add and recomputes it on every future write — no Work writer can desync it. These
// tests hand-build the pre-migration schema (work_meta had no `title_key`) and apply ONLY the new SQL file,
// so they exercise the real normalization, generation, and fail-loud behavior in isolation.

// A full-width (ideographic) space — NFKC folds it to a plain space, which the key then removes.
const IDEO = "\u3000";

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0066_flawless_the_professor.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0066 subset the migration reads and keys: work_meta WITHOUT `title_key`.
async function createPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE authors (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE work_meta (
      author_id text NOT NULL REFERENCES authors(id),
      entry_id text PRIMARY KEY REFERENCES entries(id),
      language text NOT NULL,
      title text NOT NULL,
      work_type text NOT NULL,
      origin text NOT NULL
    );
    INSERT INTO authors (id, name) VALUES ('author-1', 'A. Writer');
  `);
}

async function seedWork(
  pglite: PGlite,
  entryId: string,
  title: string,
  origin = "imported"
): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.query(
    `INSERT INTO work_meta (entry_id, author_id, language, title, work_type, origin)
     VALUES ($1, 'author-1', 'en', $2, 'book', $3);`,
    [entryId, title, origin]
  );
}

describe("0066 canonical Work duplicate-candidate key migration", () => {
  it("keys every Work from its display title on add without rewriting the title, preserving punctuation/CJK/diacritics", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    await seedWork(pglite, "w-plus", "C++ Primer");
    await seedWork(pglite, "w-clean", "  Clean   Code  ");
    // A whitespace variant (ideographic space) of the same title — NFKC folds it, so it keys identically.
    await seedWork(pglite, "w-clean-variant", `Clean${IDEO}Code`);
    await seedWork(pglite, "w-cjk", "红楼梦");
    await seedWork(pglite, "w-diacritic", "Naïve");
    await seedWork(pglite, "w-edition", "Clean Code 2nd Edition");

    await applyMigrationFile(pglite);

    const rows = await pglite.query<{ entry_id: string; title: string; title_key: string }>(
      "SELECT entry_id, title, title_key FROM work_meta ORDER BY entry_id"
    );
    const byId = new Map(rows.rows.map((row) => [row.entry_id, row]));

    // Keys: NFKC + Unicode lowercase + whitespace removed; punctuation, CJK, and diacritics preserved.
    expect(byId.get("w-plus")?.title_key).toBe("c++primer");
    expect(byId.get("w-clean")?.title_key).toBe("cleancode");
    expect(byId.get("w-clean-variant")?.title_key).toBe("cleancode");
    expect(byId.get("w-cjk")?.title_key).toBe("红楼梦");
    expect(byId.get("w-diacritic")?.title_key).toBe("naïve");
    expect(byId.get("w-edition")?.title_key).toBe("cleancode2ndedition");

    // Display titles are NEVER rewritten by the generated key.
    expect(byId.get("w-plus")?.title).toBe("C++ Primer");
    expect(byId.get("w-clean")?.title).toBe("  Clean   Code  ");
    expect(byId.get("w-diacritic")?.title).toBe("Naïve");
  });

  it("keeps the key NON-unique: distinct Works may share a title key", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedWork(pglite, "w-a", "Clean Code");
    await seedWork(pglite, "w-b", "CLEAN CODE");

    await applyMigrationFile(pglite);

    const shared = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_meta WHERE title_key = 'cleancode'"
    );
    expect(shared.rows[0]?.count).toBe(2);

    // A third Work whose title generates the same key is accepted — no uniqueness constraint blocks it.
    await seedWork(pglite, "w-c", "CleanCode");
    const afterInsert = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_meta WHERE title_key = 'cleancode'"
    );
    expect(afterInsert.rows[0]?.count).toBe(3);
  });

  it("generates the key automatically and rejects any explicit title_key write", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedWork(pglite, "w-1", "Some Title");

    await applyMigrationFile(pglite);

    // A plain insert supplies no title_key; PostgreSQL generates it from the title.
    await seedWork(pglite, "w-auto", "Fresh Title");
    const generated = await pglite.query<{ title_key: string }>(
      "SELECT title_key FROM work_meta WHERE entry_id = 'w-auto'"
    );
    expect(generated.rows[0]?.title_key).toBe("freshtitle");

    // The key is database-owned: writing it directly is rejected, so it can never desync from the title.
    await pglite.exec(`INSERT INTO entries (id, type) VALUES ('w-explicit', 'work');`);
    await expect(
      pglite.query(
        `INSERT INTO work_meta (entry_id, author_id, language, title, work_type, origin, title_key)
         VALUES ('w-explicit', 'author-1', 'en', 'Explicit', 'book', 'manual', 'hand-written')`
      )
    ).rejects.toThrow();
  });

  it("aborts atomically on a title that is blank after normalization, leaving no column or partial mutation", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedWork(pglite, "w-good", "Real Title");
    // A title that is only ideographic spaces is blank after NFKC + whitespace removal → fail loud.
    await seedWork(pglite, "w-blank", `${IDEO}${IDEO}`);

    await expect(applyMigrationFile(pglite)).rejects.toThrow();

    // The failing ADD COLUMN rolled back entirely: the generated column does not exist and no title changed.
    const column = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_name = 'work_meta' AND column_name = 'title_key'`
    );
    expect(column.rows[0]?.count).toBe(0);

    const rows = await pglite.query<{ entry_id: string; title: string }>(
      "SELECT entry_id, title FROM work_meta ORDER BY entry_id"
    );
    expect(rows.rows).toEqual([
      { entry_id: "w-blank", title: "　　" },
      { entry_id: "w-good", title: "Real Title" }
    ]);
  });
});
