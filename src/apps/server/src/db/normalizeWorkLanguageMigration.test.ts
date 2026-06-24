import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0005_normalize_work_language.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

describe("0005 work_meta language normalization", () => {
  it("normalizes legacy free-text and whitespace-padded languages into the v0 set", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);

    await pglite.exec(`
      INSERT INTO authors (id, name) VALUES ('author-mig', 'Legacy');
      INSERT INTO entries (id, type) VALUES
        ('w-hant', 'work'), ('w-cn', 'work'), ('w-en', 'work'),
        ('w-fr', 'work'), ('w-und', 'work'), ('w-zh', 'work');
      INSERT INTO work_meta (entry_id, author_id, language, title, work_type) VALUES
        ('w-hant', 'author-mig', ' zh-Hant ', 'A', 'book'),
        ('w-cn', 'author-mig', 'zh-CN ', 'B', 'book'),
        ('w-en', 'author-mig', ' EN ', 'C', 'book'),
        ('w-fr', 'author-mig', 'fr', 'D', 'book'),
        ('w-und', 'author-mig', 'und', 'E', 'book'),
        ('w-zh', 'author-mig', 'zh', 'F', 'book');
    `);

    await applyMigrationFile(pglite);

    const result = await pglite.query<{ entry_id: string; language: string }>(
      "SELECT entry_id, language FROM work_meta ORDER BY entry_id"
    );
    const byId = new Map(result.rows.map((row) => [row.entry_id, row.language]));

    expect(byId.get("w-hant")).toBe("zh-TW");
    expect(byId.get("w-cn")).toBe("zh-CN");
    expect(byId.get("w-en")).toBe("en");
    expect(byId.get("w-fr")).toBe("en");
    expect(byId.get("w-und")).toBe("en");
    expect(byId.get("w-zh")).toBe("zh-CN");
  });
});
