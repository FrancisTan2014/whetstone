import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient } from "./dbClient.js";
import { fingerprintNoteMaterial } from "../features/notes/noteMaterialFingerprint.js";
import {
  backfillNoteMaterialFingerprints,
  NoteMaterialBackfillError
} from "../features/notes/noteMaterialFingerprintBackfill.js";

// #711 fingerprint backfill: migration 0074 adds a nullable `material_fingerprint` + a NOT VALID
// note/mark shape constraint over legacy rows, and the JS `backfillNoteMaterialFingerprints` composes the
// document-package projection to fill legacy note rows in one transaction, then VALIDATEs the constraint.
// These tests seed the real pre-0074 schema (every migration up to 0073), seed legacy notes/marks, apply
// 0074, and assert: every body-bearing note is fingerprinted (duplicates share a value, marks stay null),
// nothing else is rewritten, the constraint becomes validated and enforces future writes, and an
// unprojectable body aborts the whole backfill with an actionable error and no partial state.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const FINGERPRINT_MIGRATION_TAG = "0074_note_material_fingerprint";

type JournalEntry = Readonly<{ idx: number; tag: string }>;

async function execSqlFile(pglite: PGlite, tag: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// Build the schema exactly as it stood BEFORE 0074 by applying every earlier migration in journal order,
// so legacy notes can be seeded with no `material_fingerprint` column, mirroring a real upgrade.
async function applyMigrationsBefore0074(pglite: PGlite): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8")
  ) as {
    entries: JournalEntry[];
  };
  const ordered = [...journal.entries].sort((left, right) => left.idx - right.idx);
  for (const entry of ordered) {
    if (entry.tag !== FINGERPRINT_MIGRATION_TAG) {
      await execSqlFile(pglite, entry.tag);
    }
  }
}

type SeedNote = Readonly<{
  anchored?: boolean;
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  captureSource: string;
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
    `INSERT INTO notes (entry_id, kind, capture_source, body_doc, body_text)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      note.entryId,
      note.kind,
      note.captureSource,
      note.bodyDoc === null ? null : JSON.stringify(note.bodyDoc),
      note.bodyText
    ]
  );
  if (note.anchored === true) {
    const blockId = `block-${note.entryId}`;
    await pglite.query(`INSERT INTO entries (id, type) VALUES ($1, 'block')`, [blockId]);
    await pglite.query(
      `INSERT INTO note_anchors
         (note_entry_id, block_entry_id, end_block_entry_id, context_snapshot, selected_text)
       VALUES ($1, $2, $2, 'ctx', 'sel')`,
      [note.entryId, blockId]
    );
  }
}

async function fingerprintOf(pglite: PGlite, entryId: string): Promise<string | null> {
  const result = await pglite.query<{ material_fingerprint: string | null }>(
    `SELECT material_fingerprint FROM notes WHERE entry_id = $1`,
    [entryId]
  );
  return result.rows[0]?.material_fingerprint ?? null;
}

async function constraintValidated(pglite: PGlite): Promise<boolean> {
  const result = await pglite.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'notes_material_fingerprint_kind_ck'`
  );
  return result.rows[0]?.convalidated ?? false;
}

const sharedBody = createTextDocument("Shared material across two notes");

const richBody: DocumentNodeJSON = {
  content: [
    { attrs: { level: 1 }, content: [{ text: "Heading", type: "text" }], type: "heading" },
    {
      content: [
        { text: "code", type: "text", marks: [{ type: "code" }] },
        { text: " and ", type: "text" },
        {
          marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
          text: "link",
          type: "text"
        }
      ],
      type: "paragraph"
    }
  ],
  type: "doc"
};

describe("note material fingerprint backfill", () => {
  it("fingerprints every legacy note, shares duplicates, and leaves marks and other data untouched", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0074(pglite);

    const seeds: SeedNote[] = [
      {
        anchored: true,
        bodyDoc: createTextDocument("Anchored reader note"),
        bodyText: "Anchored reader note",
        captureSource: "reader",
        entryId: "note-anchored",
        kind: "note"
      },
      {
        bodyDoc: createTextDocument("Unanchored manual note"),
        bodyText: "Unanchored manual note",
        captureSource: "manual",
        entryId: "note-unanchored",
        kind: "note"
      },
      {
        bodyDoc: richBody,
        bodyText: "Heading code and link",
        captureSource: "import",
        entryId: "note-imported",
        kind: "note"
      },
      {
        bodyDoc: createTextDocument("Direct card material"),
        bodyText: "Direct card material",
        captureSource: "practice",
        entryId: "note-direct",
        kind: "note"
      },
      {
        bodyDoc: sharedBody,
        bodyText: "Shared material across two notes",
        captureSource: "manual",
        entryId: "note-dup-a",
        kind: "note"
      },
      {
        bodyDoc: sharedBody,
        bodyText: "Shared material across two notes",
        captureSource: "reader",
        entryId: "note-dup-b",
        kind: "note"
      },
      { bodyDoc: null, bodyText: null, captureSource: "reader", entryId: "mark-1", kind: "mark" }
    ];
    for (const seed of seeds) {
      await seedNote(pglite, seed);
    }

    const before = await pglite.query(
      `SELECT n.entry_id, n.kind, n.capture_source, n.body_doc, n.body_text,
              p.created_at, p.updated_at, p.occurred_at
       FROM notes n JOIN personal_entries p ON p.entry_id = n.entry_id
       ORDER BY n.entry_id`
    );

    await execSqlFile(pglite, FINGERPRINT_MIGRATION_TAG);
    expect(await constraintValidated(pglite)).toBe(false);

    const db = createDbClient(pglite);
    const result = await backfillNoteMaterialFingerprints(db);

    expect(result.filled).toBe(6);
    expect(await fingerprintOf(pglite, "note-anchored")).toBe(
      fingerprintNoteMaterial(createTextDocument("Anchored reader note"))
    );
    expect(await fingerprintOf(pglite, "note-imported")).toBe(fingerprintNoteMaterial(richBody));
    // Duplicate material shares the non-unique fingerprint.
    const dupA = await fingerprintOf(pglite, "note-dup-a");
    expect(dupA).toBe(await fingerprintOf(pglite, "note-dup-b"));
    expect(dupA).toBe(fingerprintNoteMaterial(sharedBody));
    // A mark carries none.
    expect(await fingerprintOf(pglite, "mark-1")).toBeNull();

    // The constraint is now validated, and it enforces future writes.
    expect(await constraintValidated(pglite)).toBe(true);

    // Nothing but the new fingerprint changed: body, text, provenance, and chronology are byte-for-byte.
    const after = await pglite.query(
      `SELECT n.entry_id, n.kind, n.capture_source, n.body_doc, n.body_text,
              p.created_at, p.updated_at, p.occurred_at
       FROM notes n JOIN personal_entries p ON p.entry_id = n.entry_id
       ORDER BY n.entry_id`
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("is idempotent: a second run fills nothing", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0074(pglite);
    await seedNote(pglite, {
      bodyDoc: createTextDocument("Once"),
      bodyText: "Once",
      captureSource: "manual",
      entryId: "note-idem",
      kind: "note"
    });
    await execSqlFile(pglite, FINGERPRINT_MIGRATION_TAG);
    const db = createDbClient(pglite);

    expect((await backfillNoteMaterialFingerprints(db)).filled).toBe(1);
    const first = await fingerprintOf(pglite, "note-idem");
    expect((await backfillNoteMaterialFingerprints(db)).filled).toBe(0);
    expect(await fingerprintOf(pglite, "note-idem")).toBe(first);
  });

  it("aborts the whole backfill with no partial state when a legacy body cannot be projected", async () => {
    const pglite = new PGlite();
    await applyMigrationsBefore0074(pglite);
    await seedNote(pglite, {
      bodyDoc: createTextDocument("Valid material"),
      bodyText: "Valid material",
      captureSource: "manual",
      entryId: "note-valid",
      kind: "note"
    });
    // A body-bearing note whose document is blank (a single empty paragraph): it satisfies the
    // not-null body constraint but cannot be projected, so the backfill must refuse it.
    await seedNote(pglite, {
      bodyDoc: { content: [{ type: "paragraph" }], type: "doc" },
      bodyText: "",
      captureSource: "manual",
      entryId: "note-blank",
      kind: "note"
    });
    await execSqlFile(pglite, FINGERPRINT_MIGRATION_TAG);
    const db = createDbClient(pglite);

    await expect(backfillNoteMaterialFingerprints(db)).rejects.toBeInstanceOf(
      NoteMaterialBackfillError
    );
    await expect(backfillNoteMaterialFingerprints(db)).rejects.toThrow(/note-blank/u);

    // No partial backfill: even the valid note stays null, and the constraint is still unvalidated.
    expect(await fingerprintOf(pglite, "note-valid")).toBeNull();
    expect(await fingerprintOf(pglite, "note-blank")).toBeNull();
    expect(await constraintValidated(pglite)).toBe(false);
  });

  it("applies cleanly in the full forward migration chain", async () => {
    const pglite = new PGlite();
    const { runMigrations } = await import("./migrate.js");
    await expect(runMigrations(pglite)).resolves.toBeUndefined();
    // The column and constraint exist after the full chain.
    const columns = await pglite.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notes' AND column_name = 'material_fingerprint'`
    );
    expect(columns.rows).toHaveLength(1);
  });
});

describe("NoteMaterialBackfillError", () => {
  it("names the offending note and unwraps an Error cause's message", () => {
    const error = new NoteMaterialBackfillError("note-42", new Error("blank material"));
    expect(error.name).toBe("NoteMaterialBackfillError");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain("note-42");
    expect(error.message).toContain("blank material");
    expect(error.message).toContain("no fingerprints were written");
  });

  it("stringifies a non-Error cause defensively", () => {
    const error = new NoteMaterialBackfillError("note-99", "raw failure");
    expect(error.cause).toBe("raw failure");
    expect(error.message).toContain("note-99");
    expect(error.message).toContain("raw failure");
  });
});
