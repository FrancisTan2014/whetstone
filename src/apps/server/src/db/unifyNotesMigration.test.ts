import { PGlite } from "@electric-sql/pglite";
import { isValidDocument } from "@whetstone/document";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

// #620 data migration: the separate `memory_notes` store folds into the unified `notes` facet. Every
// memory note becomes a `notes` row (`kind = 'note'`) under the SAME `entry_id`, its `entries.type`
// flips `memory_note` → `note`, `memory_prompts.note_entry_id` is repointed from `entries` to `notes`,
// and `memory_notes` is dropped. Because no id changes, ownership (`personal_entries`), provenance
// (`derived_from`), prompt edges (`contains`), and the whole scheduling substrate
// (`memory_prompts` → `review_cards`/`review_events`) keep working untouched. These tests seed the
// pre-0052 shape by hand (mirroring `noteRichBodyMigration.test.ts`) and assert the exact preserved
// ids, bodies, capture sources, timestamps, links, and schedules, plus each fail-loud guard A–G.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0052_silky_silver_surfer.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// Create the pre-0052 subset of the schema the migration reads and rewrites. `memory_prompts.note_entry_id`
// is named exactly as Drizzle did (`memory_prompts_note_entry_id_entries_id_fk`, referencing `entries`) so
// step 3's DROP CONSTRAINT resolves. `entryLinksToFk` can be dropped so a dangling `derived_from` target
// can be seeded for the guard-G test (production keeps the FK, which makes guard G defense-in-depth).
async function createPreMigrationSchema(
  pglite: PGlite,
  { entryLinksToFk = true }: { entryLinksToFk?: boolean } = {}
): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE notes (
      body_doc jsonb,
      body_text text,
      capture_source text NOT NULL,
      entry_id text PRIMARY KEY REFERENCES entries(id),
      kind text NOT NULL,
      CONSTRAINT notes_kind_body_ck CHECK (
        (kind = 'note' AND body_doc IS NOT NULL AND body_text IS NOT NULL)
        OR (kind = 'mark' AND body_doc IS NULL AND body_text IS NULL)
      )
    );
    CREATE TABLE memory_notes (
      body_doc jsonb NOT NULL,
      body_text text NOT NULL,
      capture_source text NOT NULL,
      entry_id text PRIMARY KEY REFERENCES entries(id)
    );
    CREATE TABLE note_anchors (
      block_entry_id text NOT NULL REFERENCES entries(id),
      context_snapshot text NOT NULL,
      end_block_entry_id text NOT NULL REFERENCES entries(id),
      end_offset integer,
      note_entry_id text PRIMARY KEY REFERENCES entries(id),
      selected_text text NOT NULL,
      start_offset integer
    );
    CREATE TABLE personal_entries (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      user_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE entry_links (
      from_entry_id text NOT NULL REFERENCES entries(id),
      to_entry_id text NOT NULL${entryLinksToFk ? " REFERENCES entries(id)" : ""},
      type text NOT NULL,
      CONSTRAINT entry_links_pk PRIMARY KEY (from_entry_id, to_entry_id, type)
    );
    CREATE TABLE memory_prompts (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      note_entry_id text NOT NULL
        CONSTRAINT memory_prompts_note_entry_id_entries_id_fk REFERENCES entries(id),
      cue_doc jsonb NOT NULL,
      cue_text text NOT NULL,
      answer_doc jsonb,
      answer_text text,
      lifecycle text NOT NULL,
      chunk_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE review_cards (
      target_entry_id text PRIMARY KEY REFERENCES entries(id),
      user_id text NOT NULL,
      status text NOT NULL,
      requested_retention double precision NOT NULL,
      stability double precision NOT NULL,
      difficulty double precision NOT NULL,
      elapsed_days integer NOT NULL,
      scheduled_days integer NOT NULL,
      learning_steps integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      state text NOT NULL,
      due_at timestamptz NOT NULL,
      last_reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE review_events (
      id text PRIMARY KEY,
      target_entry_id text NOT NULL REFERENCES entries(id),
      type text NOT NULL,
      rating text,
      occurred_at timestamptz NOT NULL
    );
  `);
}

function doc(text: string): unknown {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function seedEntry(pglite: PGlite, id: string, type: string): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, $2)", [id, type]);
}

async function seedNote(
  pglite: PGlite,
  entryId: string,
  kind: "note" | "mark",
  captureSource: string,
  body: string | null
): Promise<void> {
  await pglite.query(
    "INSERT INTO notes (body_doc, body_text, capture_source, entry_id, kind) VALUES ($1, $2, $3, $4, $5)",
    [body === null ? null : JSON.stringify(doc(body)), body, captureSource, entryId, kind]
  );
}

async function seedMemoryNote(
  pglite: PGlite,
  entryId: string,
  captureSource: string,
  body: string,
  bodyDoc: unknown = doc(body)
): Promise<void> {
  await pglite.query(
    "INSERT INTO memory_notes (body_doc, body_text, capture_source, entry_id) VALUES ($1, $2, $3, $4)",
    [JSON.stringify(bodyDoc), body, captureSource, entryId]
  );
}

async function seedAnchor(
  pglite: PGlite,
  noteEntryId: string,
  blockEntryId: string
): Promise<void> {
  await pglite.query(
    `INSERT INTO note_anchors
       (block_entry_id, context_snapshot, end_block_entry_id, end_offset, note_entry_id, selected_text, start_offset)
       VALUES ($1, 'the quick brown fox', $1, 5, $2, 'quick', 0)`,
    [blockEntryId, noteEntryId]
  );
}

async function seedPersonalEntry(
  pglite: PGlite,
  entryId: string,
  userId: string,
  when: string
): Promise<void> {
  await pglite.query(
    `INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $3)`,
    [entryId, userId, when]
  );
}

async function seedLink(pglite: PGlite, from: string, to: string, type: string): Promise<void> {
  await pglite.query(
    "INSERT INTO entry_links (from_entry_id, to_entry_id, type) VALUES ($1, $2, $3)",
    [from, to, type]
  );
}

async function seedPrompt(
  pglite: PGlite,
  entryId: string,
  noteEntryId: string,
  lifecycle: string
): Promise<void> {
  await pglite.query(
    `INSERT INTO memory_prompts (entry_id, note_entry_id, cue_doc, cue_text, lifecycle)
       VALUES ($1, $2, $3, 'cue', $4)`,
    [entryId, noteEntryId, JSON.stringify(doc("cue")), lifecycle]
  );
}

async function seedCard(
  pglite: PGlite,
  targetEntryId: string,
  userId: string,
  status: string,
  dueAt: string,
  lastReviewedAt: string | null
): Promise<void> {
  await pglite.query(
    `INSERT INTO review_cards (
       target_entry_id, user_id, status, requested_retention, stability, difficulty,
       elapsed_days, scheduled_days, learning_steps, reps, lapses, state, due_at, last_reviewed_at
     ) VALUES ($1, $2, $3, 0.9, 3.5, 5.1, 1, 2, 0, 4, 1, 'review', $4, $5)`,
    [targetEntryId, userId, status, dueAt, lastReviewedAt]
  );
}

async function seedEvent(
  pglite: PGlite,
  id: string,
  targetEntryId: string,
  rating: string,
  occurredAt: string
): Promise<void> {
  await pglite.query(
    "INSERT INTO review_events (id, target_entry_id, type, rating, occurred_at) VALUES ($1, $2, 'rating', $3, $4)",
    [id, targetEntryId, rating, occurredAt]
  );
}

type NoteRow = {
  body_doc: unknown;
  body_text: string | null;
  capture_source: string;
  entry_id: string;
  kind: string;
};

describe("0052 unify-notes migration", () => {
  it("folds memory notes into the unified notes facet, preserving ids, bodies, links, and schedules", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // A shared source block, an anchored reader note, and a one-tap reader mark — already unified notes.
    await seedEntry(pglite, "block-1", "block");
    await seedEntry(pglite, "reader-note", "note");
    await seedEntry(pglite, "reader-mark", "note");
    await seedNote(pglite, "reader-note", "note", "reader", "a reader note body");
    await seedNote(pglite, "reader-mark", "mark", "reader", null);
    await seedAnchor(pglite, "reader-note", "block-1");
    await seedAnchor(pglite, "reader-mark", "block-1");
    await seedPersonalEntry(pglite, "reader-note", "user-1", "2026-02-01T00:00:00.000Z");
    await seedPersonalEntry(pglite, "reader-mark", "user-1", "2026-02-02T00:00:00.000Z");
    await seedLink(pglite, "reader-note", "block-1", "annotates");

    // Three memory notes: manual (no prompts), imported (one ready prompt), source-derived (two prompts).
    await seedEntry(pglite, "mem-manual", "memory_note");
    await seedEntry(pglite, "mem-import", "memory_note");
    await seedEntry(pglite, "mem-source", "memory_note");
    await seedEntry(pglite, "source-work", "work");
    await seedMemoryNote(pglite, "mem-manual", "manual", "manual memory body");
    await seedMemoryNote(pglite, "mem-import", "import", "imported memory body");
    await seedMemoryNote(pglite, "mem-source", "tool", "source-derived memory body");
    await seedPersonalEntry(pglite, "mem-manual", "user-1", "2026-02-03T00:00:00.000Z");
    await seedPersonalEntry(pglite, "mem-import", "user-1", "2026-02-04T00:00:00.000Z");
    await seedPersonalEntry(pglite, "mem-source", "user-2", "2026-02-05T00:00:00.000Z");
    // Provenance: the source-derived note points back at its source work.
    await seedLink(pglite, "mem-source", "source-work", "derived_from");

    // Prompts: mem-import has one, mem-source has two, mem-manual has none.
    await seedEntry(pglite, "prompt-a", "memory_prompt");
    await seedEntry(pglite, "prompt-b", "memory_prompt");
    await seedEntry(pglite, "prompt-c", "memory_prompt");
    await seedPrompt(pglite, "prompt-a", "mem-import", "ready");
    await seedPrompt(pglite, "prompt-b", "mem-source", "ready");
    await seedPrompt(pglite, "prompt-c", "mem-source", "draft");
    await seedLink(pglite, "mem-import", "prompt-a", "contains");
    await seedLink(pglite, "mem-source", "prompt-b", "contains");
    await seedLink(pglite, "mem-source", "prompt-c", "contains");

    // Scheduling substrate: an active+reviewed (snoozed to the future) card, and a paused card.
    await seedCard(
      pglite,
      "prompt-a",
      "user-1",
      "active",
      "2026-03-01T00:00:00.000Z",
      "2026-02-10T00:00:00.000Z"
    );
    await seedCard(pglite, "prompt-b", "user-2", "paused", "2026-02-20T00:00:00.000Z", null);
    await seedEvent(pglite, "event-a1", "prompt-a", "good", "2026-02-10T00:00:00.000Z");
    await seedEvent(pglite, "event-a2", "prompt-a", "easy", "2026-02-11T00:00:00.000Z");

    const cardsBefore = await pglite.query("SELECT * FROM review_cards ORDER BY target_entry_id");
    const eventsBefore = await pglite.query("SELECT * FROM review_events ORDER BY id");

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    // Every memory note is now a unified note under the SAME id, kind 'note', body + capture verbatim.
    const memManual = (
      await pglite.query<NoteRow>(
        "SELECT body_doc, body_text, capture_source, entry_id, kind FROM notes WHERE entry_id = 'mem-manual'"
      )
    ).rows[0] as NoteRow;
    expect(memManual).toEqual({
      body_doc: doc("manual memory body"),
      body_text: "manual memory body",
      capture_source: "manual",
      entry_id: "mem-manual",
      kind: "note"
    });
    const memImport = (
      await pglite.query<NoteRow>(
        "SELECT capture_source, body_text, kind FROM notes WHERE entry_id = 'mem-import'"
      )
    ).rows[0] as NoteRow;
    expect(memImport).toEqual({
      capture_source: "import",
      body_text: "imported memory body",
      kind: "note"
    });
    const memSource = (
      await pglite.query<NoteRow>(
        "SELECT capture_source, body_text, kind FROM notes WHERE entry_id = 'mem-source'"
      )
    ).rows[0] as NoteRow;
    expect(memSource.capture_source).toBe("tool");
    expect(memSource.kind).toBe("note");

    // The reader note + mark are untouched (still one row each, still their original shape).
    const readerRows = await pglite.query<NoteRow>(
      "SELECT entry_id, kind, capture_source FROM notes WHERE entry_id IN ('reader-note','reader-mark') ORDER BY entry_id"
    );
    expect(readerRows.rows).toEqual([
      { entry_id: "reader-mark", kind: "mark", capture_source: "reader" },
      { entry_id: "reader-note", kind: "note", capture_source: "reader" }
    ]);

    // No duplication: exactly five note rows total (2 reader + 3 memory), each once.
    const noteCount = await pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notes"
    );
    expect(noteCount.rows[0]?.count).toBe("5");

    // Entry types flipped memory_note → note; nothing left typed memory_note.
    const memTypes = await pglite.query<{ type: string }>(
      "SELECT DISTINCT type FROM entries WHERE id IN ('mem-manual','mem-import','mem-source')"
    );
    expect(memTypes.rows).toEqual([{ type: "note" }]);
    const stillMemoryNote = await pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM entries WHERE type = 'memory_note'"
    );
    expect(stillMemoryNote.rows[0]?.count).toBe("0");
    // Prompt entries keep their type.
    const promptTypes = await pglite.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM entries WHERE type = 'memory_prompt'"
    );
    expect(promptTypes.rows[0]?.count).toBe("3");

    // Ownership + chronology (personal_entries) untouched for every migrated note.
    const owners = await pglite.query<{ entry_id: string; user_id: string; occurred_at: Date }>(
      "SELECT entry_id, user_id, occurred_at FROM personal_entries WHERE entry_id LIKE 'mem-%' ORDER BY entry_id"
    );
    expect(owners.rows).toEqual([
      {
        entry_id: "mem-import",
        user_id: "user-1",
        occurred_at: new Date("2026-02-04T00:00:00.000Z")
      },
      {
        entry_id: "mem-manual",
        user_id: "user-1",
        occurred_at: new Date("2026-02-03T00:00:00.000Z")
      },
      {
        entry_id: "mem-source",
        user_id: "user-2",
        occurred_at: new Date("2026-02-05T00:00:00.000Z")
      }
    ]);

    // Provenance (derived_from) and prompt edges (contains) intact.
    const links = await pglite.query<{ from_entry_id: string; to_entry_id: string; type: string }>(
      "SELECT from_entry_id, to_entry_id, type FROM entry_links WHERE type IN ('derived_from','contains') ORDER BY type, to_entry_id"
    );
    expect(links.rows).toEqual([
      { from_entry_id: "mem-import", to_entry_id: "prompt-a", type: "contains" },
      { from_entry_id: "mem-source", to_entry_id: "prompt-b", type: "contains" },
      { from_entry_id: "mem-source", to_entry_id: "prompt-c", type: "contains" },
      { from_entry_id: "mem-source", to_entry_id: "source-work", type: "derived_from" }
    ]);

    // Prompts still point at their notes and now the FK targets `notes`.
    const prompts = await pglite.query<{ entry_id: string; note_entry_id: string }>(
      "SELECT entry_id, note_entry_id FROM memory_prompts ORDER BY entry_id"
    );
    expect(prompts.rows).toEqual([
      { entry_id: "prompt-a", note_entry_id: "mem-import" },
      { entry_id: "prompt-b", note_entry_id: "mem-source" },
      { entry_id: "prompt-c", note_entry_id: "mem-source" }
    ]);
    const fk = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'memory_prompts_note_entry_id_notes_entry_id_fk'
       ) AS exists`
    );
    expect(fk.rows[0]?.exists).toBe(true);

    // Scheduling schedules (cards + events) are byte-for-byte unchanged.
    const cardsAfter = await pglite.query("SELECT * FROM review_cards ORDER BY target_entry_id");
    expect(cardsAfter.rows).toEqual(cardsBefore.rows);
    const eventsAfter = await pglite.query("SELECT * FROM review_events ORDER BY id");
    expect(eventsAfter.rows).toEqual(eventsBefore.rows);

    // The separate memory-note store is gone.
    const memoryNotesTable = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memory_notes') IS NOT NULL AS exists"
    );
    expect(memoryNotesTable.rows[0]?.exists).toBe(false);
  });

  it("aborts (guard A) when a memory_note entry has no memory_notes row", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "ghost", "memory_note");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /entries\.type and memory_notes are out of sync/u
    );
  });

  it("aborts (guard A) when a memory_notes row's entry is not typed memory_note", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "mislabelled", "note");
    await seedMemoryNote(pglite, "mislabelled", "manual", "body");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /entries\.type and memory_notes are out of sync/u
    );
  });

  it("aborts (guard B) when a memory_notes.entry_id already exists in notes", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "collide", "memory_note");
    await seedNote(pglite, "collide", "note", "reader", "existing note body");
    await seedMemoryNote(pglite, "collide", "manual", "memory body");
    await seedPersonalEntry(pglite, "collide", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/already exists in notes/u);
  });

  it("aborts (guard C) when a memory note has no personal_entries ownership row", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "unowned", "memory_note");
    await seedMemoryNote(pglite, "unowned", "manual", "memory body");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/no personal_entries ownership row/u);
  });

  it("aborts (guard D) when a memory note's body_doc is not a doc object", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "malformed", "memory_note");
    await seedMemoryNote(pglite, "malformed", "manual", "body", ["not", "an", "object"]);
    await seedPersonalEntry(pglite, "malformed", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /malformed body_doc.*or a blank body_text/u
    );
  });

  it("aborts (guard D) when a memory note's body_text is blank", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "blank", "memory_note");
    await seedMemoryNote(pglite, "blank", "manual", "   ", doc("has doc"));
    await seedPersonalEntry(pglite, "blank", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /malformed body_doc.*or a blank body_text/u
    );
  });

  // The tightened Guard D rejects a `doc`-typed object whose STRUCTURE fails the shared document schema,
  // not just a non-`doc` shape — after #620 a copied body becomes a canonical note validated by
  // `isValidDocument`. Each case below is a top-level `doc` that `isValidDocument` rejects (asserted), so
  // the migration must abort rather than seed an invalid canonical note.
  it("aborts (guard D) when a doc's content is not an array", async () => {
    const badDoc = { type: "doc", content: "not-an-array" };
    expect(isValidDocument(badDoc)).toBe(false);

    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "bad-content", "memory_note");
    await seedMemoryNote(pglite, "bad-content", "manual", "present", badDoc);
    await seedPersonalEntry(pglite, "bad-content", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/structurally invalid body_doc/u);
  });

  it("aborts (guard D) when a doc contains an unsupported child node type", async () => {
    const badDoc = { type: "doc", content: [{ type: "bogusNode", content: [] }] };
    expect(isValidDocument(badDoc)).toBe(false);

    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "bad-node", "memory_note");
    await seedMemoryNote(pglite, "bad-node", "manual", "present", badDoc);
    await seedPersonalEntry(pglite, "bad-node", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/structurally invalid body_doc/u);
  });

  it("aborts (guard D) when a text run carries an unsupported mark type", async () => {
    const badDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "blink" }] }] }
      ]
    };
    expect(isValidDocument(badDoc)).toBe(false);

    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "bad-mark", "memory_note");
    await seedMemoryNote(pglite, "bad-mark", "manual", "present", badDoc);
    await seedPersonalEntry(pglite, "bad-mark", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/structurally invalid body_doc/u);
  });

  it("migrates a valid RICH body (heading, nested blockquote, bold mark) untouched", async () => {
    const richDoc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Heading" }] },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }]
            }
          ]
        }
      ]
    };
    expect(isValidDocument(richDoc)).toBe(true);

    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "rich", "memory_note");
    await seedMemoryNote(pglite, "rich", "manual", "rich body", richDoc);
    await seedPersonalEntry(pglite, "rich", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const row = await pglite.query<{
      body_doc: unknown;
      body_text: string;
      capture_source: string;
      kind: string;
    }>("SELECT body_doc, body_text, capture_source, kind FROM notes WHERE entry_id = 'rich'");
    expect(row.rows[0]).toEqual({
      body_doc: richDoc,
      body_text: "rich body",
      capture_source: "manual",
      kind: "note"
    });
  });

  it("aborts (guard E) when a memory note has an invalid capture_source", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedEntry(pglite, "badsource", "memory_note");
    await seedMemoryNote(pglite, "badsource", "bogus", "memory body");
    await seedPersonalEntry(pglite, "badsource", "user-1", "2026-02-01T00:00:00.000Z");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/invalid capture_source/u);
  });

  it("aborts (guard F) when a prompt references a missing memory_notes owner", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    // A reader note (not a memory note) that a prompt wrongly points at.
    await seedEntry(pglite, "reader-note", "note");
    await seedNote(pglite, "reader-note", "note", "reader", "reader body");
    await seedEntry(pglite, "orphan-prompt", "memory_prompt");
    await seedPrompt(pglite, "orphan-prompt", "reader-note", "ready");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /references a missing memory_notes owner/u
    );
  });

  it("aborts (guard G) when a derived_from provenance link points to a missing entry", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite, { entryLinksToFk: false });
    await seedEntry(pglite, "mem-source", "memory_note");
    await seedMemoryNote(pglite, "mem-source", "tool", "memory body");
    await seedPersonalEntry(pglite, "mem-source", "user-1", "2026-02-01T00:00:00.000Z");
    await seedLink(pglite, "mem-source", "ghost-work", "derived_from");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /provenance link.*points to a missing entry/u
    );
  });

  it("applies the whole forward chain and drops memory_notes at the #620 end-state", async () => {
    const pglite = new PGlite();
    await expect(runMigrations(pglite)).resolves.toBeUndefined();

    const tableExists = async (name: string): Promise<boolean> => {
      const result = await pglite.query<{ exists: boolean }>(
        `SELECT to_regclass('public.${name}') IS NOT NULL AS exists`
      );
      return result.rows[0]?.exists ?? false;
    };
    expect(await tableExists("memory_notes")).toBe(false);
    expect(await tableExists("notes")).toBe(true);

    const fk = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'memory_prompts_note_entry_id_notes_entry_id_fk'
       ) AS exists`
    );
    expect(fk.rows[0]?.exists).toBe(true);
  });
});
