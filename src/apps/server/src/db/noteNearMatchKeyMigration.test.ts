import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createTextDocument,
  projectNearMatchKey,
  type DocumentNodeJSON
} from "@whetstone/document";

import { createDbClient } from "./dbClient.js";
import { backfillNoteNearMatchKeys } from "../features/notes/noteNearMatchBackfill.js";

// #713 near-match key backfill: migration 0076 adds nullable `relaxed_key` + `relaxed_key_length` and a
// VALID pair constraint, and the JS `backfillNoteNearMatchKeys` composes the document-package projection to
// fill legacy ELIGIBLE note rows in one transaction. These tests seed the real pre-0076 schema (every
// migration up to 0075), seed legacy notes/marks, apply 0076, and assert: every eligible note gets its key +
// length (duplicates share a value), unsupported notes and marks stay null, nothing else is rewritten, the
// pair constraint is valid immediately and rejects a lone column, and the backfill is idempotent.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const NEAR_MIGRATION_TAG = "0076_note_near_match_key";

type JournalEntry = Readonly<{ idx: number; tag: string }>;

async function execSqlFile(pglite: PGlite, tag: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// Build the schema exactly as it stood BEFORE 0076 by applying every earlier migration in journal order, so
// legacy notes can be seeded with no near-match columns, mirroring a real upgrade.
async function applyMigrationsBefore0076(pglite: PGlite): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8")
  ) as { entries: JournalEntry[] };
  const ordered = [...journal.entries].sort((left, right) => left.idx - right.idx);
  for (const entry of ordered) {
    if (entry.tag !== NEAR_MIGRATION_TAG) {
      await execSqlFile(pglite, entry.tag);
    }
  }
}

type SeedNote = Readonly<{
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  entryId: string;
  kind: "note" | "mark";
}>;

async function seedNote(pglite: PGlite, note: SeedNote): Promise<void> {
  await pglite.query(`INSERT INTO entries (id, type) VALUES ($1, 'note')`, [note.entryId]);
  await pglite.query(
    `INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3)`,
    [note.entryId, "user-1", new Date("2026-01-01T00:00:00.000Z")]
  );
  await pglite.query(
    `INSERT INTO notes (entry_id, kind, capture_source, body_doc, body_text, material_fingerprint)
     VALUES ($1, $2, 'manual', $3, $4, $5)`,
    [
      note.entryId,
      note.kind,
      note.bodyDoc === null ? null : JSON.stringify(note.bodyDoc),
      note.bodyText,
      note.kind === "note" ? "fp" : null
    ]
  );
}

async function keyOf(
  pglite: PGlite,
  entryId: string
): Promise<{ relaxed_key: string | null; relaxed_key_length: number | null }> {
  const result = await pglite.query<{
    relaxed_key: string | null;
    relaxed_key_length: number | null;
  }>(`SELECT relaxed_key, relaxed_key_length FROM notes WHERE entry_id = $1`, [entryId]);
  return result.rows[0]!;
}

async function pairConstraintValidated(pglite: PGlite): Promise<boolean> {
  const result = await pglite.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'notes_relaxed_key_pair_ck'`
  );
  return result.rows[0]?.convalidated ?? false;
}

const sharedBody = createTextDocument("shared near material across two notes");

describe("note near-match key backfill", () => {
  it("fills eligible legacy notes, shares duplicates, and leaves unsupported notes, marks, and other data untouched", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0076(pglite);

    const seeds: SeedNote[] = [
      {
        bodyDoc: createTextDocument("in terms of the design"),
        bodyText: "in terms of the design",
        entryId: "note-eligible",
        kind: "note"
      },
      {
        bodyDoc: sharedBody,
        bodyText: "shared near material across two notes",
        entryId: "note-dup-a",
        kind: "note"
      },
      {
        bodyDoc: sharedBody,
        bodyText: "shared near material across two notes",
        entryId: "note-dup-b",
        kind: "note"
      },
      {
        bodyDoc: createTextDocument("distributed"),
        bodyText: "distributed",
        entryId: "note-single-word",
        kind: "note"
      },
      { bodyDoc: null, bodyText: null, entryId: "mark-1", kind: "mark" }
    ];
    for (const seed of seeds) {
      await seedNote(pglite, seed);
    }

    const before = await pglite.query(
      `SELECT n.entry_id, n.kind, n.body_doc, n.body_text, n.material_fingerprint,
              p.created_at, p.updated_at, p.occurred_at
       FROM notes n JOIN personal_entries p ON p.entry_id = n.entry_id ORDER BY n.entry_id`
    );

    await execSqlFile(pglite, NEAR_MIGRATION_TAG);
    // The pair constraint is added VALID immediately (all rows are null, which satisfies it).
    expect(await pairConstraintValidated(pglite)).toBe(true);

    const db = createDbClient(pglite);
    const result = await backfillNoteNearMatchKeys(db);

    // Three eligible notes filled; the single-word note and the mark are not.
    expect(result.filled).toBe(3);
    const expected = projectNearMatchKey(createTextDocument("in terms of the design"))!;
    expect(await keyOf(pglite, "note-eligible")).toEqual({
      relaxed_key: expected.relaxedKey,
      relaxed_key_length: expected.codePointLength
    });
    // Duplicate material shares the non-unique relaxed key.
    const dupA = await keyOf(pglite, "note-dup-a");
    expect(dupA).toEqual(await keyOf(pglite, "note-dup-b"));
    expect(dupA.relaxed_key).toBe(projectNearMatchKey(sharedBody)!.relaxedKey);
    // The single-word note and the mark stay null.
    expect(await keyOf(pglite, "note-single-word")).toEqual({
      relaxed_key: null,
      relaxed_key_length: null
    });
    expect(await keyOf(pglite, "mark-1")).toEqual({ relaxed_key: null, relaxed_key_length: null });

    // Nothing but the new key columns changed: body, text, fingerprint, and chronology are byte-for-byte.
    const after = await pglite.query(
      `SELECT n.entry_id, n.kind, n.body_doc, n.body_text, n.material_fingerprint,
              p.created_at, p.updated_at, p.occurred_at
       FROM notes n JOIN personal_entries p ON p.entry_id = n.entry_id ORDER BY n.entry_id`
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("is idempotent: a second run fills nothing", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0076(pglite);
    await seedNote(pglite, {
      bodyDoc: createTextDocument("in terms of the design"),
      bodyText: "in terms of the design",
      entryId: "note-idem",
      kind: "note"
    });
    await execSqlFile(pglite, NEAR_MIGRATION_TAG);
    const db = createDbClient(pglite);

    expect((await backfillNoteNearMatchKeys(db)).filled).toBe(1);
    const first = await keyOf(pglite, "note-idem");
    expect((await backfillNoteNearMatchKeys(db)).filled).toBe(0);
    expect(await keyOf(pglite, "note-idem")).toEqual(first);
  });

  it("rejects a lone key column via the pair constraint", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0076(pglite);
    await execSqlFile(pglite, NEAR_MIGRATION_TAG);
    await seedNote(pglite, {
      bodyDoc: createTextDocument("in terms of the design"),
      bodyText: "in terms of the design",
      entryId: "note-lone",
      kind: "note"
    });
    // A relaxed key without its length (or vice versa) violates the pair constraint.
    await expect(
      pglite.query(`UPDATE notes SET relaxed_key = 'x' WHERE entry_id = 'note-lone'`)
    ).rejects.toThrow(/notes_relaxed_key_pair_ck/u);
  });

  it("applies cleanly in the full forward migration chain", async () => {
    const pglite = new PGlite();
    const { runMigrations } = await import("./migrate.js");
    await expect(runMigrations(pglite)).resolves.toBeUndefined();
    const columns = await pglite.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notes' AND column_name IN ('relaxed_key', 'relaxed_key_length')`
    );
    expect(columns.rows).toHaveLength(2);
  });
});
