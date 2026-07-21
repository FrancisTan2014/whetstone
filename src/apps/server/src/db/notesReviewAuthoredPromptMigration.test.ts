import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #687 authored-prompt uniqueness migration: widen the partial unique index from `current_note`-only to
// BOTH authored reveal kinds (`current_note` and `expected_response`), so a note owns at most one authored
// retrieval contract regardless of which reveal it uses, while historical `legacy_custom` siblings stay
// unconstrained. It only drops and re-creates the index — it converts no rows — so every existing
// current-note, expected-response, and legacy prompt (and its card/history) must survive untouched. These
// tests seed the pre-0060 shape with the OLD `current_note`-only index, apply the migration, assert exact
// preservation, then assert the widened end state: a second authored prompt of EITHER kind on a note is
// rejected while legacy siblings and cross-note authored prompts remain valid.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0060_brown_raza.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0060 subset: memory_prompts WITH the three-kind reveal-shape check (post-0056) and the OLD
// `current_note`-only partial unique index (post-0055), plus the review card and event tables so the
// "cards/history unchanged" claim is real.
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
      reveal_kind text NOT NULL,
      chunk_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT memory_prompts_reveal_shape_ck CHECK (
        (reveal_kind = 'current_note' AND lifecycle = 'ready' AND answer_doc IS NULL AND answer_text IS NULL)
        OR (reveal_kind = 'expected_response' AND lifecycle = 'ready' AND answer_doc IS NOT NULL AND answer_text IS NOT NULL)
        OR (reveal_kind = 'legacy_custom' AND lifecycle = 'ready' AND answer_doc IS NOT NULL AND answer_text IS NOT NULL)
        OR (reveal_kind = 'legacy_custom' AND lifecycle = 'draft' AND answer_doc IS NULL AND answer_text IS NULL)
      )
    );
    CREATE UNIQUE INDEX "memory_prompts_one_current_note_per_note_uq"
      ON memory_prompts (note_entry_id) WHERE reveal_kind = 'current_note';
    CREATE TABLE review_cards (
      target_entry_id text PRIMARY KEY REFERENCES entries(id),
      user_id text NOT NULL,
      status text NOT NULL,
      due_at timestamptz NOT NULL
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

async function seedNote(pglite: PGlite, entryId: string): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'note')", [entryId]);
  await pglite.query(
    "INSERT INTO notes (entry_id, kind, body_doc, body_text) VALUES ($1, 'note', $2, $3)",
    [entryId, JSON.stringify(doc(`body:${entryId}`)), `body:${entryId}`]
  );
}

async function insertPrompt(
  pglite: PGlite,
  id: string,
  noteEntryId: string,
  revealKind: string,
  lifecycle: string,
  answered: boolean
): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'memory_prompt')", [id]);
  await pglite.query(
    `INSERT INTO memory_prompts
       (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
       VALUES ($1, $2, $3, 'q', $4, $5, $6, $7, '2026-01-02T03:04:05.000Z')`,
    [
      id,
      noteEntryId,
      JSON.stringify(doc(`cue:${id}`)),
      answered ? JSON.stringify(doc(`a:${id}`)) : null,
      answered ? `a:${id}` : null,
      lifecycle,
      revealKind
    ]
  );
}

type PromptRow = {
  reveal_kind: string;
  lifecycle: string;
  answer_text: string | null;
  answer_doc: unknown;
};

async function promptRow(pglite: PGlite, id: string): Promise<PromptRow> {
  const result = await pglite.query<PromptRow>(
    "SELECT reveal_kind, lifecycle, answer_text, answer_doc FROM memory_prompts WHERE entry_id = $1",
    [id]
  );
  return result.rows[0] as PromptRow;
}

describe("0060 notes-review authored-prompt uniqueness migration", () => {
  it("preserves every current-note, expected-response, and legacy prompt (and its card/history) exactly", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1");
    await seedNote(pglite, "note-2");
    await insertPrompt(pglite, "cn-1", "note-1", "current_note", "ready", false);
    await insertPrompt(pglite, "lc-ready", "note-1", "legacy_custom", "ready", true);
    await insertPrompt(pglite, "lc-draft", "note-1", "legacy_custom", "draft", false);
    await insertPrompt(pglite, "er-2", "note-2", "expected_response", "ready", true);
    await pglite.query(
      "INSERT INTO review_cards (target_entry_id, user_id, status, due_at) VALUES ('cn-1', 'user-1', 'active', $1)",
      ["2026-01-05T00:00:00.000Z"]
    );
    await pglite.query(
      "INSERT INTO review_events (id, target_entry_id, type, rating, occurred_at) VALUES ('ev-1', 'cn-1', 'rating', 'good', $1)",
      ["2026-01-04T00:00:00.000Z"]
    );

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    expect(await promptRow(pglite, "cn-1")).toEqual({
      reveal_kind: "current_note",
      lifecycle: "ready",
      answer_text: null,
      answer_doc: null
    });
    expect(await promptRow(pglite, "er-2")).toEqual({
      reveal_kind: "expected_response",
      lifecycle: "ready",
      answer_text: "a:er-2",
      answer_doc: doc("a:er-2")
    });
    expect(await promptRow(pglite, "lc-ready")).toEqual({
      reveal_kind: "legacy_custom",
      lifecycle: "ready",
      answer_text: "a:lc-ready",
      answer_doc: doc("a:lc-ready")
    });
    expect(await promptRow(pglite, "lc-draft")).toEqual({
      reveal_kind: "legacy_custom",
      lifecycle: "draft",
      answer_text: null,
      answer_doc: null
    });

    const cards = await pglite.query<{ due_at: Date; status: string }>(
      "SELECT due_at, status FROM review_cards WHERE target_entry_id = 'cn-1'"
    );
    expect(cards.rows[0]).toEqual({
      due_at: new Date("2026-01-05T00:00:00.000Z"),
      status: "active"
    });
    const events = await pglite.query<{ id: string; type: string; rating: string | null }>(
      "SELECT id, type, rating FROM review_events WHERE target_entry_id = 'cn-1'"
    );
    expect(events.rows).toEqual([{ id: "ev-1", type: "rating", rating: "good" }]);
  });

  it("permits at most one authored prompt of EITHER reveal kind per note after the migration", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1");
    await seedNote(pglite, "note-2");
    await applyMigrationFile(pglite);

    // note-1: one authored current_note prompt is accepted.
    await expect(
      insertPrompt(pglite, "cn-1", "note-1", "current_note", "ready", false)
    ).resolves.toBeUndefined();
    // A second current_note on the same note is still rejected (the original invariant holds).
    await expect(
      insertPrompt(pglite, "cn-1b", "note-1", "current_note", "ready", false)
    ).rejects.toThrow(/memory_prompts_one_authored_prompt_per_note_uq/u);
    // An expected_response on the SAME note is now ALSO rejected: only one authored prompt per note.
    await expect(
      insertPrompt(pglite, "er-1", "note-1", "expected_response", "ready", true)
    ).rejects.toThrow(/memory_prompts_one_authored_prompt_per_note_uq/u);
    // Legacy siblings remain unconstrained: many per note.
    await expect(
      insertPrompt(pglite, "lc-1", "note-1", "legacy_custom", "ready", true)
    ).resolves.toBeUndefined();
    await expect(
      insertPrompt(pglite, "lc-2", "note-1", "legacy_custom", "ready", true)
    ).resolves.toBeUndefined();

    // note-2: an authored expected_response prompt is accepted as the single authored prompt.
    await expect(
      insertPrompt(pglite, "er-2", "note-2", "expected_response", "ready", true)
    ).resolves.toBeUndefined();
    // A current_note on that same note is rejected once an expected_response already claims the slot.
    await expect(
      insertPrompt(pglite, "cn-2", "note-2", "current_note", "ready", false)
    ).rejects.toThrow(/memory_prompts_one_authored_prompt_per_note_uq/u);
    // A second expected_response is rejected too.
    await expect(
      insertPrompt(pglite, "er-2b", "note-2", "expected_response", "ready", true)
    ).rejects.toThrow(/memory_prompts_one_authored_prompt_per_note_uq/u);
  });
});
