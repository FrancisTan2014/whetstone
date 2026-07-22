import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// #721 recoverable staged PDF imports. Migration 0064 creates `pdf_import_attempts` and
// `pdf_import_ranges`. These tests apply ONLY that SQL file to an empty database and prove the
// invariants the runner and store rely on: single admission (one running attempt), the typed-failure
// check, the state whitelist, and cascade deletion of an attempt's committed ranges.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0064_futuristic_sharon_ventura.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

async function insertAttempt(
  pglite: PGlite,
  id: string,
  state: string,
  failure = "NULL"
): Promise<void> {
  await pglite.exec(
    `INSERT INTO pdf_import_attempts (id, user_id, source_hash, state, failure)
     VALUES ('${id}', 'user-1', 'sha', '${state}', ${failure});`
  );
}

describe("0064 recoverable staged PDF imports migration", () => {
  let pglite: PGlite;

  beforeEach(async () => {
    pglite = new PGlite();
    await applyMigrationFile(pglite);
  });

  it("admits at most one running attempt", async () => {
    await insertAttempt(pglite, "a1", "running");
    await expect(insertAttempt(pglite, "a2", "running")).rejects.toThrow();
    // Non-running rows are unconstrained by the partial index.
    await insertAttempt(pglite, "a3", "queued");
    await insertAttempt(pglite, "a4", "queued");
  });

  it("enforces a typed failure exactly when failed", async () => {
    await expect(insertAttempt(pglite, "bad", "failed")).rejects.toThrow();
    await expect(
      insertAttempt(pglite, "leak", "queued", `'{"kind":"malformed"}'::jsonb`)
    ).rejects.toThrow();
    await insertAttempt(pglite, "ok", "failed", `'{"kind":"malformed"}'::jsonb`);
  });

  it("rejects an unknown state", async () => {
    await expect(insertAttempt(pglite, "weird", "paused")).rejects.toThrow();
  });

  it("cascades range deletion when an attempt is removed", async () => {
    await insertAttempt(pglite, "a1", "queued");
    await pglite.exec(
      `INSERT INTO pdf_import_ranges (attempt_id, range_index, start_page, end_page, fingerprint, payload)
       VALUES ('a1', 0, 1, 2, 'fp', '{}'::jsonb);`
    );
    await pglite.exec("DELETE FROM pdf_import_attempts WHERE id = 'a1';");
    const rows = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pdf_import_ranges"
    );
    expect(rows.rows[0]?.count).toBe(0);
  });
});
