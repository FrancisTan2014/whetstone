import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// #725 durable Work creation-review attempts. Migration 0067 creates `work_creation_attempts`. These
// tests apply ONLY that SQL file to an empty database and prove the invariants the store relies on: one
// active attempt per owner, the state and source-kind whitelists, the stage-ownership check, the
// snapshot/fingerprint both-or-neither check, the revision floor, and the deliberate absence of any
// foreign key into content (so a restore leaves no Work, ReadingUnit, or Block behind).

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0067_clean_stellaris.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

type AttemptFields = Readonly<{
  id: string;
  userId?: string;
  sourceKind?: string;
  state?: string;
  stagePath?: string;
  snapshot?: string;
  fingerprint?: string;
  revision?: number;
}>;

async function insertAttempt(pglite: PGlite, fields: AttemptFields): Promise<void> {
  const userId = fields.userId ?? "user-1";
  const sourceKind = fields.sourceKind ?? "markdown";
  const state = fields.state ?? "pending";
  const stagePath = fields.stagePath === undefined ? "NULL" : `'${fields.stagePath}'`;
  const snapshot = fields.snapshot === undefined ? "NULL" : `'${fields.snapshot}'::jsonb`;
  const fingerprint = fields.fingerprint === undefined ? "NULL" : `'${fields.fingerprint}'`;
  const revision = fields.revision ?? 0;
  await pglite.exec(
    `INSERT INTO work_creation_attempts
       (id, user_id, proposed_title, proposed_author_name, proposed_language, proposed_work_type,
        source_kind, state, stage_path, candidate_snapshot, candidate_fingerprint, revision, expires_at)
     VALUES
       ('${fields.id}', '${userId}', 'Title', 'Author', 'en', 'book',
        '${sourceKind}', '${state}', ${stagePath}, ${snapshot}, ${fingerprint}, ${revision}, now());`
  );
}

describe("0067 work creation attempts migration", () => {
  let pglite: PGlite;

  beforeEach(async () => {
    pglite = new PGlite();
    await applyMigrationFile(pglite);
  });

  it("admits at most one active attempt per owner", async () => {
    await insertAttempt(pglite, { id: "a1", state: "pending" });
    await expect(insertAttempt(pglite, { id: "a2", state: "finalizing" })).rejects.toThrow();
    // A terminal attempt is unconstrained, and a different owner is independent.
    await insertAttempt(pglite, { id: "a3", state: "completed" });
    await insertAttempt(pglite, { id: "a4", userId: "user-2", state: "pending" });
  });

  it("rejects an unknown state or source kind", async () => {
    await expect(insertAttempt(pglite, { id: "s", state: "paused" })).rejects.toThrow();
    await expect(insertAttempt(pglite, { id: "k", sourceKind: "audio" })).rejects.toThrow();
  });

  it("allows a stage only for an ordinary upload kind", async () => {
    await insertAttempt(pglite, { id: "md", sourceKind: "markdown", stagePath: "stage-md" });
    await insertAttempt(pglite, { id: "ep", userId: "u2", sourceKind: "epub", stagePath: "stage-ep" });
    await expect(
      insertAttempt(pglite, { id: "man", sourceKind: "manual", stagePath: "stage-man" })
    ).rejects.toThrow();
    await expect(
      insertAttempt(pglite, { id: "pdf", sourceKind: "pdf", stagePath: "stage-pdf" })
    ).rejects.toThrow();
  });

  it("requires a fingerprint exactly when a snapshot is present", async () => {
    await expect(
      insertAttempt(pglite, { id: "leak", snapshot: "[]" })
    ).rejects.toThrow();
    await expect(
      insertAttempt(pglite, { id: "orphan", fingerprint: "fp" })
    ).rejects.toThrow();
    await insertAttempt(pglite, { id: "ok", snapshot: "[]", fingerprint: "fp" });
  });

  it("rejects a negative revision", async () => {
    await expect(insertAttempt(pglite, { id: "neg", revision: -1 })).rejects.toThrow();
  });

  it("declares no foreign key, so a restore materializes no Work or content", async () => {
    const fks = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM information_schema.table_constraints
        WHERE table_name = 'work_creation_attempts' AND constraint_type = 'FOREIGN KEY';`
    );
    expect(fks.rows[0]?.count).toBe(0);
  });
});
