import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #617: migration 0048 lifts Memory's inline FSRS schedule into the shared review substrate. It seeds
// one `review_cards` row per enrolled (`scheduled`) prompt — preserving the full FSRS state verbatim
// and stamping the pre-substrate default requested retention (0.9) — moves the append-only review log
// into `review_events` (keyed by prompt Entry id so history survives an edit back to draft), flips the
// `scheduled` lifecycle to `ready`, and drops the FSRS columns + `memory_prompt_reviews`. It is
// fail-loud: it refuses to migrate an incomplete FSRS card or an ownerless enrolled prompt rather than
// seeding a broken card or dropping data silently. These tests apply the single migration file against a
// hand-seeded pre-0048 database (the only shape 0048 touches) to prove that data contract.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0048_shared_review_cards.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0048 shape of just the tables/columns 0048 reads or alters.
async function seedPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE personal_entries (
      entry_id text PRIMARY KEY,
      user_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE memory_prompts (
      entry_id text PRIMARY KEY,
      note_entry_id text NOT NULL,
      cue_doc jsonb NOT NULL,
      cue_text text NOT NULL,
      answer_doc jsonb,
      answer_text text,
      lifecycle text NOT NULL,
      chunk_id text,
      created_at timestamptz DEFAULT now() NOT NULL,
      stability double precision,
      difficulty double precision,
      elapsed_days integer,
      scheduled_days integer,
      learning_steps integer,
      reps integer,
      lapses integer,
      state text,
      last_reviewed_at timestamptz,
      due_at timestamptz
    );
    CREATE TABLE memory_prompt_reviews (
      id text PRIMARY KEY,
      prompt_entry_id text NOT NULL,
      rating text NOT NULL,
      reviewed_at timestamptz NOT NULL
    );
    CREATE INDEX memory_prompts_due_idx ON memory_prompts (due_at);
  `);
}

interface ScheduledFields {
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly learningSteps: number;
  readonly reps: number;
  readonly lapses: number;
  readonly state: string;
  readonly dueAt: string;
  readonly lastReviewedAt: string;
}

const completeCard: ScheduledFields = {
  stability: 3.5,
  difficulty: 5.1,
  elapsedDays: 2,
  scheduledDays: 4,
  learningSteps: 1,
  reps: 6,
  lapses: 1,
  state: "review",
  dueAt: "2026-07-05T00:00:00.000Z",
  lastReviewedAt: "2026-07-01T00:00:00.000Z"
};

async function seedOwner(pglite: PGlite, noteId: string, userId: string): Promise<void> {
  await pglite.exec(
    `INSERT INTO entries (id, type) VALUES ('${noteId}', 'memory_note');
     INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
       VALUES ('${noteId}', '${userId}', now(), now(), now());`
  );
}

async function seedScheduledPrompt(
  pglite: PGlite,
  id: string,
  noteId: string,
  card: ScheduledFields
): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${id}', 'memory_prompt');`);
  await pglite.query(
    `INSERT INTO memory_prompts (
       entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle,
       stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state,
       last_reviewed_at, due_at
     ) VALUES ($1, $2, '{}'::jsonb, 'cue', '{}'::jsonb, 'ans', 'scheduled',
       $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      noteId,
      card.stability,
      card.difficulty,
      card.elapsedDays,
      card.scheduledDays,
      card.learningSteps,
      card.reps,
      card.lapses,
      card.state,
      card.lastReviewedAt,
      card.dueAt
    ]
  );
}

async function seedDraftPrompt(pglite: PGlite, id: string, noteId: string): Promise<void> {
  await pglite.exec(
    `INSERT INTO entries (id, type) VALUES ('${id}', 'memory_prompt');
     INSERT INTO memory_prompts (entry_id, note_entry_id, cue_doc, cue_text, lifecycle)
       VALUES ('${id}', '${noteId}', '{}'::jsonb, 'cue', 'draft');`
  );
}

async function columnExists(pglite: PGlite, table: string, column: string): Promise<boolean> {
  const result = await pglite.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column]
  );
  return result.rows[0]?.exists ?? false;
}

describe("0048 shared review-card substrate migration", () => {
  it("seeds one review card per scheduled prompt, preserving FSRS state and stamping rr=0.9", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedOwner(pglite, "note-1", "user-1");
    await seedScheduledPrompt(pglite, "p-sched", "note-1", completeCard);
    await seedDraftPrompt(pglite, "p-draft", "note-1");

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const cards = await pglite.query<{
      target_entry_id: string;
      user_id: string;
      status: string;
      requested_retention: number;
      stability: number;
      difficulty: number;
      elapsed_days: number;
      scheduled_days: number;
      learning_steps: number;
      reps: number;
      lapses: number;
      state: string;
      due_at: string;
      last_reviewed_at: string;
    }>(
      `SELECT target_entry_id, user_id, status, requested_retention, stability, difficulty,
         elapsed_days, scheduled_days, learning_steps, reps, lapses, state,
         due_at::text AS due_at, last_reviewed_at::text AS last_reviewed_at
       FROM review_cards`
    );

    expect(cards.rows).toHaveLength(1);
    const card = cards.rows[0];
    expect(card?.target_entry_id).toBe("p-sched");
    expect(card?.user_id).toBe("user-1");
    expect(card?.status).toBe("active");
    expect(card?.requested_retention).toBe(0.9);
    expect(card?.stability).toBe(completeCard.stability);
    expect(card?.difficulty).toBe(completeCard.difficulty);
    expect(card?.elapsed_days).toBe(completeCard.elapsedDays);
    expect(card?.scheduled_days).toBe(completeCard.scheduledDays);
    expect(card?.learning_steps).toBe(completeCard.learningSteps);
    expect(card?.reps).toBe(completeCard.reps);
    expect(card?.lapses).toBe(completeCard.lapses);
    expect(card?.state).toBe(completeCard.state);
    expect(new Date(card?.due_at ?? "").toISOString()).toBe(completeCard.dueAt);
    expect(new Date(card?.last_reviewed_at ?? "").toISOString()).toBe(completeCard.lastReviewedAt);
  });

  it("flips scheduled prompts to ready, leaves drafts, and drops the FSRS columns + due index", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedOwner(pglite, "note-1", "user-1");
    await seedScheduledPrompt(pglite, "p-sched", "note-1", completeCard);
    await seedDraftPrompt(pglite, "p-draft", "note-1");

    await applyMigrationFile(pglite);

    const prompts = await pglite.query<{ entry_id: string; lifecycle: string }>(
      "SELECT entry_id, lifecycle FROM memory_prompts ORDER BY entry_id"
    );
    expect(prompts.rows).toEqual([
      { entry_id: "p-draft", lifecycle: "draft" },
      { entry_id: "p-sched", lifecycle: "ready" }
    ]);

    for (const column of [
      "stability",
      "difficulty",
      "elapsed_days",
      "scheduled_days",
      "learning_steps",
      "reps",
      "lapses",
      "state",
      "last_reviewed_at",
      "due_at"
    ]) {
      expect(await columnExists(pglite, "memory_prompts", column)).toBe(false);
    }

    const index = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memory_prompts_due_idx') IS NOT NULL AS exists"
    );
    expect(index.rows[0]?.exists).toBe(false);
  });

  it("moves every review into review_events keyed by prompt id, even for a prompt edited back to draft", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedOwner(pglite, "note-1", "user-1");
    await seedScheduledPrompt(pglite, "p-sched", "note-1", completeCard);
    // A prompt that was scheduled (accumulating review history) then edited back to a draft: it has no
    // card, but its history must still migrate so a later re-enrollment keeps the log.
    await seedDraftPrompt(pglite, "p-edited", "note-1");
    await pglite.exec(`
      INSERT INTO memory_prompt_reviews (id, prompt_entry_id, rating, reviewed_at) VALUES
        ('rv-1', 'p-sched', 'good', '2026-07-01T00:00:00.000Z'),
        ('rv-2', 'p-edited', 'again', '2026-06-20T00:00:00.000Z');
    `);

    await applyMigrationFile(pglite);

    const events = await pglite.query<{
      id: string;
      target_entry_id: string;
      type: string;
      rating: string | null;
      occurred_at: string;
    }>(
      `SELECT id, target_entry_id, type, rating, occurred_at::text AS occurred_at
       FROM review_events ORDER BY id`
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      id: "rv-1",
      target_entry_id: "p-sched",
      type: "rating",
      rating: "good"
    });
    expect(new Date(events.rows[0]?.occurred_at ?? "").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
    expect(events.rows[1]).toMatchObject({
      id: "rv-2",
      target_entry_id: "p-edited",
      type: "rating",
      rating: "again"
    });

    // p-edited is a draft, so it gets no card even though it has history.
    const cards = await pglite.query<{ target_entry_id: string }>(
      "SELECT target_entry_id FROM review_cards ORDER BY target_entry_id"
    );
    expect(cards.rows).toEqual([{ target_entry_id: "p-sched" }]);
  });

  it("drops the memory_prompt_reviews table", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await applyMigrationFile(pglite);

    const exists = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.memory_prompt_reviews') IS NOT NULL AS exists"
    );
    expect(exists.rows[0]?.exists).toBe(false);
  });

  it("aborts fail-loud when a scheduled prompt has an incomplete FSRS card", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedOwner(pglite, "note-1", "user-1");
    // A scheduled prompt whose FSRS card is missing a scheduling column (stability NULL). The migration
    // must refuse it rather than seed a broken card.
    await pglite.exec(`
      INSERT INTO entries (id, type) VALUES ('p-sched', 'memory_prompt');
      INSERT INTO memory_prompts (
        entry_id, note_entry_id, cue_doc, cue_text, lifecycle,
        difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, due_at
      ) VALUES ('p-sched', 'note-1', '{}'::jsonb, 'cue', 'scheduled',
        5.1, 2, 4, 1, 6, 1, 'review', now());
    `);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/incomplete FSRS card/);
  });

  it("aborts fail-loud when a scheduled prompt has no resolvable owner", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    // Note entry with NO personal_entries row -> ownerless.
    await pglite.exec(`INSERT INTO entries (id, type) VALUES ('note-x', 'memory_note');`);
    await seedScheduledPrompt(pglite, "p-orphan", "note-x", completeCard);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/no resolvable owner/);
  });
});
