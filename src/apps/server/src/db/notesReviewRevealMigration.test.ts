import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #657 data migration: give every existing Memory prompt an explicit persisted `reveal_kind`, backfilled
// as `legacy_custom` without inspecting or altering any other column, guarded by three fail-loud
// pre-checks (orphan/non-note target, incoherent lifecycle/answer shape, review card on a non-ready
// prompt) and finished by the `memory_prompts_reveal_shape_ck` constraint. These tests seed the pre-0054
// shape and assert exact preservation, the backfill, each guard, and the enforced end-state shapes.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0054_notes_review_reveal.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0054 subset the migration reads and rewrites: entries, notes (the prompt target), memory_prompts
// WITHOUT `reveal_kind` and WITHOUT the reveal-shape check, and review_cards (only the columns the guard
// joins on).
async function createPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE notes (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      kind text NOT NULL,
      body_doc jsonb,
      body_text text
    );
    CREATE TABLE memory_prompts (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      note_entry_id text NOT NULL REFERENCES notes(entry_id),
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
      due_at timestamptz NOT NULL
    );
  `);
}

function doc(text: string): unknown {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function seedNote(pglite: PGlite, entryId: string, kind: string): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'note')", [entryId]);
  await pglite.query(
    "INSERT INTO notes (entry_id, kind, body_doc, body_text) VALUES ($1, $2, $3, $4)",
    [entryId, kind, JSON.stringify(doc(`body:${entryId}`)), `body:${entryId}`]
  );
}

type SeedPrompt = Readonly<{
  id: string;
  noteEntryId: string;
  lifecycle: "ready" | "draft";
  answered: boolean;
  chunkId?: string | null;
}>;

async function seedPrompt(pglite: PGlite, prompt: SeedPrompt): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'memory_prompt')", [prompt.id]);
  await pglite.query(
    `INSERT INTO memory_prompts
       (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, chunk_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      prompt.id,
      prompt.noteEntryId,
      JSON.stringify(doc(`cue:${prompt.id}`)),
      `cue:${prompt.id}`,
      prompt.answered ? JSON.stringify(doc(`answer:${prompt.id}`)) : null,
      prompt.answered ? `answer:${prompt.id}` : null,
      prompt.lifecycle,
      prompt.chunkId ?? null,
      "2026-01-02T03:04:05.000Z"
    ]
  );
}

async function seedCard(pglite: PGlite, targetEntryId: string): Promise<void> {
  await pglite.query(
    "INSERT INTO review_cards (target_entry_id, user_id, status, due_at) VALUES ($1, 'user-1', 'active', now())",
    [targetEntryId]
  );
}

type PromptRow = {
  reveal_kind: string;
  lifecycle: string;
  cue_text: string;
  answer_text: string | null;
  answer_doc: unknown;
  chunk_id: string | null;
  note_entry_id: string;
  created_at: Date;
};

async function promptRow(pglite: PGlite, id: string): Promise<PromptRow> {
  const result = await pglite.query<PromptRow>(
    `SELECT reveal_kind, lifecycle, cue_text, answer_text, answer_doc, chunk_id, note_entry_id, created_at
       FROM memory_prompts WHERE entry_id = $1`,
    [id]
  );
  return result.rows[0] as PromptRow;
}

describe("0054 notes-review reveal migration", () => {
  it("backfills every prompt to legacy_custom, preserving all other columns exactly", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1", "note");
    await seedPrompt(pglite, {
      id: "ready-1",
      noteEntryId: "note-1",
      lifecycle: "ready",
      answered: true,
      chunkId: "chunk-7"
    });
    await seedCard(pglite, "ready-1");
    await seedPrompt(pglite, {
      id: "draft-1",
      noteEntryId: "note-1",
      lifecycle: "draft",
      answered: false
    });

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const ready = await promptRow(pglite, "ready-1");
    expect(ready.reveal_kind).toBe("legacy_custom");
    expect(ready.lifecycle).toBe("ready");
    expect(ready.cue_text).toBe("cue:ready-1");
    expect(ready.answer_text).toBe("answer:ready-1");
    expect(ready.answer_doc).toEqual(doc("answer:ready-1"));
    expect(ready.chunk_id).toBe("chunk-7");
    expect(ready.note_entry_id).toBe("note-1");
    expect(ready.created_at).toEqual(new Date("2026-01-02T03:04:05.000Z"));

    const draft = await promptRow(pglite, "draft-1");
    expect(draft.reveal_kind).toBe("legacy_custom");
    expect(draft.lifecycle).toBe("draft");
    expect(draft.answer_text).toBeNull();
    expect(draft.answer_doc).toBeNull();
  });

  it("enforces the three reveal shapes after migrating, rejecting the invalid ones", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1", "note");
    await seedPrompt(pglite, {
      id: "ready-1",
      noteEntryId: "note-1",
      lifecycle: "ready",
      answered: true
    });
    await applyMigrationFile(pglite);

    await pglite.query("INSERT INTO entries (id, type) VALUES ('cn-1', 'memory_prompt')");
    // A current_note prompt (ready, answerless) is the accepted durable shape.
    await expect(
      pglite.query(
        `INSERT INTO memory_prompts
           (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
           VALUES ('cn-1', 'note-1', $1, 'q', NULL, NULL, 'ready', 'current_note', now())`,
        [JSON.stringify(doc("q"))]
      )
    ).resolves.toBeDefined();

    await pglite.query("INSERT INTO entries (id, type) VALUES ('cn-bad', 'memory_prompt')");
    // A current_note prompt that is a draft (or carries an answer) violates the check.
    await expect(
      pglite.query(
        `INSERT INTO memory_prompts
           (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
           VALUES ('cn-bad', 'note-1', $1, 'q', NULL, NULL, 'draft', 'current_note', now())`,
        [JSON.stringify(doc("q"))]
      )
    ).rejects.toThrow(/memory_prompts_reveal_shape_ck/u);

    await pglite.query("INSERT INTO entries (id, type) VALUES ('lc-bad', 'memory_prompt')");
    // A ready legacy prompt with no answer violates the check.
    await expect(
      pglite.query(
        `INSERT INTO memory_prompts
           (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
           VALUES ('lc-bad', 'note-1', $1, 'q', NULL, NULL, 'ready', 'legacy_custom', now())`,
        [JSON.stringify(doc("q"))]
      )
    ).rejects.toThrow(/memory_prompts_reveal_shape_ck/u);
  });

  it("aborts when a prompt targets a non-note (mark) note", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "mark-1", "mark");
    await pglite.query("INSERT INTO entries (id, type) VALUES ('on-mark', 'memory_prompt')");
    await pglite.query(
      `INSERT INTO memory_prompts
         (entry_id, note_entry_id, cue_doc, cue_text, lifecycle, created_at)
         VALUES ('on-mark', 'mark-1', $1, 'q', 'draft', now())`,
      [JSON.stringify(doc("q"))]
    );

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/missing or non-note/u);
  });

  it("aborts on an incoherent lifecycle/answer shape (ready without an answer)", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1", "note");
    await seedPrompt(pglite, {
      id: "bad-1",
      noteEntryId: "note-1",
      lifecycle: "ready",
      answered: false
    });

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/incoherent lifecycle\/answer shape/u);
  });

  it("aborts on an incoherent lifecycle/answer shape (draft with an answer)", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1", "note");
    await seedPrompt(pglite, {
      id: "bad-2",
      noteEntryId: "note-1",
      lifecycle: "draft",
      answered: true
    });

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/incoherent lifecycle\/answer shape/u);
  });

  it("aborts when a review card is attached to a non-ready prompt", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1", "note");
    await seedPrompt(pglite, {
      id: "draft-1",
      noteEntryId: "note-1",
      lifecycle: "draft",
      answered: false
    });
    await seedCard(pglite, "draft-1");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/attached to a non-ready/u);
  });
});
