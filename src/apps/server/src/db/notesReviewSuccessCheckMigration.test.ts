import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #686 constraint migration: widen `memory_prompts_reveal_shape_ck` to admit the new `expected_response`
// reveal shape (ready, both answer projections = the authored Success check) as a strict SUPERSET of the
// prior shapes. It converts no rows — it only drops and re-adds the check — so every existing current-note
// and legacy prompt (and its card/history) must survive untouched. These tests seed the pre-0056 shape with
// the old check, apply the migration, assert exact preservation, then assert the new end-state shapes: the
// expected_response shape is accepted while partial/mixed/draft mixtures and the old-shape violations are
// still rejected.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0056_last_rachel_grey.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0056 subset: memory_prompts WITH `reveal_kind` and the OLD two-kind reveal-shape check (the
// post-0055 state), plus the review card and event tables so the "cards/history unchanged" claim is real.
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
        OR (reveal_kind = 'legacy_custom' AND lifecycle = 'ready' AND answer_doc IS NOT NULL AND answer_text IS NOT NULL)
        OR (reveal_kind = 'legacy_custom' AND lifecycle = 'draft' AND answer_doc IS NULL AND answer_text IS NULL)
      )
    );
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

type SeedPrompt = Readonly<{
  id: string;
  revealKind: "current_note" | "legacy_custom";
  lifecycle: "ready" | "draft";
  answered: boolean;
}>;

async function seedPrompt(pglite: PGlite, prompt: SeedPrompt): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'memory_prompt')", [prompt.id]);
  await pglite.query(
    `INSERT INTO memory_prompts
       (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
       VALUES ($1, 'note-1', $2, $3, $4, $5, $6, $7, $8)`,
    [
      prompt.id,
      JSON.stringify(doc(`cue:${prompt.id}`)),
      `cue:${prompt.id}`,
      prompt.answered ? JSON.stringify(doc(`answer:${prompt.id}`)) : null,
      prompt.answered ? `answer:${prompt.id}` : null,
      prompt.lifecycle,
      prompt.revealKind,
      "2026-01-02T03:04:05.000Z"
    ]
  );
}

async function insertPrompt(
  pglite: PGlite,
  id: string,
  revealKind: string,
  lifecycle: string,
  answered: boolean
): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, 'memory_prompt')", [id]);
  await pglite.query(
    `INSERT INTO memory_prompts
       (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
       VALUES ($1, 'note-1', $2, 'q', $3, $4, $5, $6, now())`,
    [
      id,
      JSON.stringify(doc("q")),
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

describe("0056 notes-review success-check constraint migration", () => {
  it("preserves every current-note and legacy prompt (and its card/history) exactly", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1");
    await seedPrompt(pglite, {
      id: "cn-1",
      revealKind: "current_note",
      lifecycle: "ready",
      answered: false
    });
    await seedPrompt(pglite, {
      id: "lc-ready",
      revealKind: "legacy_custom",
      lifecycle: "ready",
      answered: true
    });
    await seedPrompt(pglite, {
      id: "lc-draft",
      revealKind: "legacy_custom",
      lifecycle: "draft",
      answered: false
    });
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
    expect(await promptRow(pglite, "lc-ready")).toEqual({
      reveal_kind: "legacy_custom",
      lifecycle: "ready",
      answer_text: "answer:lc-ready",
      answer_doc: doc("answer:lc-ready")
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

  it("admits the expected_response shape while still rejecting partial, mixed, and draft mixtures", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedNote(pglite, "note-1");
    await applyMigrationFile(pglite);

    // Accepted: an expected_response prompt is ready with both answer projections (the Success check).
    await expect(
      insertPrompt(pglite, "er-ok", "expected_response", "ready", true)
    ).resolves.toBeUndefined();

    // Rejected: expected_response with no answer at all (a bare shape).
    await expect(
      insertPrompt(pglite, "er-empty", "expected_response", "ready", false)
    ).rejects.toThrow(/memory_prompts_reveal_shape_ck/u);

    // Rejected: expected_response as a draft (there is no draft expected_response shape).
    await expect(
      insertPrompt(pglite, "er-draft", "expected_response", "draft", true)
    ).rejects.toThrow(/memory_prompts_reveal_shape_ck/u);

    // Rejected: expected_response carrying only one of the two answer projections (mixed).
    await pglite.query("INSERT INTO entries (id, type) VALUES ('er-half', 'memory_prompt')");
    await expect(
      pglite.query(
        `INSERT INTO memory_prompts
           (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind, created_at)
           VALUES ('er-half', 'note-1', $1, 'q', $2, NULL, 'ready', 'expected_response', now())`,
        [JSON.stringify(doc("q")), JSON.stringify(doc("a"))]
      )
    ).rejects.toThrow(/memory_prompts_reveal_shape_ck/u);

    // The old shapes remain enforced: a current_note draft still violates the check.
    await expect(insertPrompt(pglite, "cn-draft", "current_note", "draft", false)).rejects.toThrow(
      /memory_prompts_reveal_shape_ck/u
    );
  });
});
