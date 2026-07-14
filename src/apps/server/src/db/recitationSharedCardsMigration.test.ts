import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #618: migration 0049 moves Recitation's inline FSRS schedule onto the shared review substrate (#617).
// It seeds one active `review_cards` row per ACTIVE passage and per whole-Work target — preserving the
// full FSRS state verbatim and stamping the recitation requested retention (0.95) — moves the append-only
// review log into `review_events` (+ Recitation-owned `recitation_review_evidence` for cue strength),
// creates a deterministic target Entry for each whole-Work aggregate and links it to its plan, and drops
// the inline FSRS/due columns + `recitation_reviews`. It is fail-loud: it refuses an incomplete FSRS
// card, an ownerless target, or a dangling review rather than seeding a broken card or dropping data.
// These tests apply the single migration file against a hand-seeded pre-0049 database (the only shape
// 0049 touches) to prove that data contract.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0049_recitation_shared_cards.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0049 shape of just the tables/columns 0049 reads or alters: the pre-substrate recitation tables
// (passages + whole-Work with inline FSRS, the reviews log) and the shared substrate tables 0048 already
// created (review_cards, review_events, entry_links), seeded empty here.
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
    CREATE TABLE entry_links (
      from_entry_id text NOT NULL,
      to_entry_id text NOT NULL,
      type text NOT NULL,
      PRIMARY KEY (from_entry_id, to_entry_id, type)
    );
    CREATE TABLE recitation_plans (
      entry_id text PRIMARY KEY,
      work_entry_id text NOT NULL,
      phase text NOT NULL
    );
    CREATE TABLE recitation_passages (
      entry_id text PRIMARY KEY,
      plan_entry_id text NOT NULL,
      order_index integer NOT NULL,
      start_block_entry_id text NOT NULL,
      start_offset integer NOT NULL,
      end_block_entry_id text NOT NULL,
      end_offset integer NOT NULL,
      source_text text NOT NULL,
      context_snapshot text NOT NULL,
      support_level text NOT NULL,
      anchor_status text NOT NULL,
      introduced_at timestamptz,
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
      due_at timestamptz,
      CONSTRAINT recitation_passages_lifecycle_ck
        CHECK (introduced_at IS NULL OR (stability IS NOT NULL AND due_at IS NOT NULL))
    );
    CREATE INDEX recitation_passages_plan_due_idx ON recitation_passages (plan_entry_id, due_at);
    CREATE TABLE recitation_reviews (
      id text PRIMARY KEY,
      passage_entry_id text NOT NULL,
      rating text NOT NULL,
      cue_strength text NOT NULL,
      reviewed_at timestamptz NOT NULL
    );
    CREATE TABLE recitation_whole_work (
      plan_entry_id text PRIMARY KEY,
      created_at timestamptz DEFAULT now() NOT NULL,
      stability double precision NOT NULL,
      difficulty double precision NOT NULL,
      elapsed_days integer NOT NULL,
      scheduled_days integer NOT NULL,
      learning_steps integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      state text NOT NULL,
      last_reviewed_at timestamptz,
      due_at timestamptz NOT NULL
    );
    CREATE TABLE review_cards (
      target_entry_id text PRIMARY KEY,
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
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL
    );
    CREATE TABLE review_events (
      id text PRIMARY KEY,
      target_entry_id text NOT NULL,
      type text NOT NULL,
      rating text,
      occurred_at timestamptz NOT NULL
    );
  `);
}

interface FsrsFields {
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

const activeCard: FsrsFields = {
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

const wholeWorkCard: FsrsFields = {
  stability: 9.9,
  difficulty: 4.2,
  elapsedDays: 3,
  scheduledDays: 10,
  learningSteps: 0,
  reps: 8,
  lapses: 2,
  state: "review",
  dueAt: "2026-08-01T00:00:00.000Z",
  lastReviewedAt: "2026-07-22T00:00:00.000Z"
};

// A plan owned by `userId` (its personal_entries facet + recitation_plans facet).
async function seedPlan(pglite: PGlite, planId: string, userId: string): Promise<void> {
  await pglite.exec(
    `INSERT INTO entries (id, type) VALUES ('${planId}', 'recitation_plan');
     INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
       VALUES ('${planId}', '${userId}', now(), now(), now());
     INSERT INTO recitation_plans (entry_id, work_entry_id, phase)
       VALUES ('${planId}', 'work-1', 'learning');`
  );
}

async function seedActivePassage(
  pglite: PGlite,
  id: string,
  planId: string,
  orderIndex: number,
  card: FsrsFields
): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${id}', 'recitation_passage');`);
  await pglite.query(
    `INSERT INTO recitation_passages (
       entry_id, plan_entry_id, order_index, start_block_entry_id, start_offset,
       end_block_entry_id, end_offset, source_text, context_snapshot, support_level,
       anchor_status, introduced_at, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, reps, lapses, state, last_reviewed_at, due_at
     ) VALUES ($1, $2, $3, 'b1', 0, 'b1', 2, 'text', 'ctx', 'full', 'anchored', now(),
       $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      planId,
      orderIndex,
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

async function seedQueuedPassage(
  pglite: PGlite,
  id: string,
  planId: string,
  orderIndex: number
): Promise<void> {
  await pglite.exec(
    `INSERT INTO entries (id, type) VALUES ('${id}', 'recitation_passage');
     INSERT INTO recitation_passages (
       entry_id, plan_entry_id, order_index, start_block_entry_id, start_offset,
       end_block_entry_id, end_offset, source_text, context_snapshot, support_level,
       anchor_status, introduced_at
     ) VALUES ('${id}', '${planId}', ${orderIndex}, 'b2', 0, 'b2', 2, 'text', 'ctx', 'full',
       'anchored', NULL);`
  );
}

async function seedWholeWork(pglite: PGlite, planId: string, card: FsrsFields): Promise<void> {
  await pglite.query(
    `INSERT INTO recitation_whole_work (
       plan_entry_id, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
       reps, lapses, state, last_reviewed_at, due_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      planId,
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

describe("0049 recitation shared review-card migration", () => {
  it("seeds an active 0.95 card for an active passage and leaves a queued passage cardless", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    await seedActivePassage(pglite, "p-active", "plan-1", 0, activeCard);
    await seedQueuedPassage(pglite, "p-queued", "plan-1", 1);

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
       FROM review_cards WHERE target_entry_id = 'p-active'`
    );
    expect(cards.rows).toHaveLength(1);
    const card = cards.rows[0];
    expect(card?.user_id).toBe("user-1");
    expect(card?.status).toBe("active");
    expect(card?.requested_retention).toBe(0.95);
    expect(card?.stability).toBe(activeCard.stability);
    expect(card?.difficulty).toBe(activeCard.difficulty);
    expect(card?.elapsed_days).toBe(activeCard.elapsedDays);
    expect(card?.scheduled_days).toBe(activeCard.scheduledDays);
    expect(card?.learning_steps).toBe(activeCard.learningSteps);
    expect(card?.reps).toBe(activeCard.reps);
    expect(card?.lapses).toBe(activeCard.lapses);
    expect(card?.state).toBe(activeCard.state);
    expect(new Date(card?.due_at ?? "").toISOString()).toBe(activeCard.dueAt);
    expect(new Date(card?.last_reviewed_at ?? "").toISOString()).toBe(activeCard.lastReviewedAt);

    // The queued passage never gets a card — the migration must not accidentally activate it.
    const queued = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM review_cards WHERE target_entry_id = 'p-queued'"
    );
    expect(queued.rows[0]?.count).toBe(0);
  });

  it("moves each review into review_events (ids preserved) with its cue strength in evidence", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    await seedActivePassage(pglite, "p-active", "plan-1", 0, activeCard);
    await pglite.exec(`
      INSERT INTO recitation_reviews (id, passage_entry_id, rating, cue_strength, reviewed_at) VALUES
        ('rv-1', 'p-active', 'good', 'opening', '2026-07-01T00:00:00.000Z'),
        ('rv-2', 'p-active', 'again', 'preceding_line', '2026-07-03T00:00:00.000Z');
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
      target_entry_id: "p-active",
      type: "rating",
      rating: "good"
    });
    expect(new Date(events.rows[0]?.occurred_at ?? "").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
    expect(events.rows[1]).toMatchObject({ id: "rv-2", rating: "again" });

    const evidence = await pglite.query<{ review_event_id: string; cue_strength: string }>(
      "SELECT review_event_id, cue_strength FROM recitation_review_evidence ORDER BY review_event_id"
    );
    expect(evidence.rows).toEqual([
      { review_event_id: "rv-1", cue_strength: "opening" },
      { review_event_id: "rv-2", cue_strength: "preceding_line" }
    ]);
  });

  it("promotes a whole-Work row to a deterministic target Entry with an active 0.95 card and a contains link, and no owner facet", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    await seedWholeWork(pglite, "plan-1", wholeWorkCard);

    await applyMigrationFile(pglite);

    const target = "plan-1:whole_work";

    // The aggregate target is a first-class Entry of the new type.
    const entry = await pglite.query<{ type: string }>("SELECT type FROM entries WHERE id = $1", [
      target
    ]);
    expect(entry.rows[0]?.type).toBe("recitation_whole_work");

    // Its card preserves the aggregate FSRS state exactly at rr 0.95.
    const card = await pglite.query<{
      user_id: string;
      status: string;
      requested_retention: number;
      stability: number;
      reps: number;
      lapses: number;
      due_at: string;
    }>(
      `SELECT user_id, status, requested_retention, stability, reps, lapses, due_at::text AS due_at
       FROM review_cards WHERE target_entry_id = $1`,
      [target]
    );
    expect(card.rows[0]?.user_id).toBe("user-1");
    expect(card.rows[0]?.status).toBe("active");
    expect(card.rows[0]?.requested_retention).toBe(0.95);
    expect(card.rows[0]?.stability).toBe(wholeWorkCard.stability);
    expect(card.rows[0]?.reps).toBe(wholeWorkCard.reps);
    expect(card.rows[0]?.lapses).toBe(wholeWorkCard.lapses);
    expect(new Date(card.rows[0]?.due_at ?? "").toISOString()).toBe(wholeWorkCard.dueAt);

    // The plan contains its aggregate target.
    const link = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM entry_links
       WHERE from_entry_id = 'plan-1' AND to_entry_id = $1 AND type = 'contains'`,
      [target]
    );
    expect(link.rows[0]?.count).toBe(1);

    // The aggregate target never surfaces on the Timeline: it has no personal_entries facet.
    const facet = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM personal_entries WHERE entry_id = $1",
      [target]
    );
    expect(facet.rows[0]?.count).toBe(0);

    // The rebuilt facet row is keyed by the target Entry id, with the FSRS columns gone.
    const rebuilt = await pglite.query<{ entry_id: string; plan_entry_id: string }>(
      "SELECT entry_id, plan_entry_id FROM recitation_whole_work"
    );
    expect(rebuilt.rows).toEqual([{ entry_id: target, plan_entry_id: "plan-1" }]);
    for (const column of ["stability", "difficulty", "reps", "lapses", "state", "due_at"]) {
      expect(await columnExists(pglite, "recitation_whole_work", column)).toBe(false);
    }
  });

  it("drops the inline FSRS columns, the due index, and the lifecycle check from recitation_passages, and drops recitation_reviews", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    await seedActivePassage(pglite, "p-active", "plan-1", 0, activeCard);

    await applyMigrationFile(pglite);

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
      expect(await columnExists(pglite, "recitation_passages", column)).toBe(false);
    }

    const index = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.recitation_passages_plan_due_idx') IS NOT NULL AS exists"
    );
    expect(index.rows[0]?.exists).toBe(false);

    const check = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.table_constraints
       WHERE constraint_name = 'recitation_passages_lifecycle_ck'`
    );
    expect(check.rows[0]?.count).toBe(0);

    const reviews = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.recitation_reviews') IS NOT NULL AS exists"
    );
    expect(reviews.rows[0]?.exists).toBe(false);
  });

  it("aborts fail-loud when an active passage has an incomplete FSRS card", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    // An active passage (introduced_at set) missing a scheduling column (stability NULL). The lifecycle
    // check is dropped only later in the migration, so we insert with the check temporarily relaxed.
    await pglite.exec(
      "ALTER TABLE recitation_passages DROP CONSTRAINT recitation_passages_lifecycle_ck;"
    );
    await pglite.exec(`
      INSERT INTO entries (id, type) VALUES ('p-bad', 'recitation_passage');
      INSERT INTO recitation_passages (
        entry_id, plan_entry_id, order_index, start_block_entry_id, start_offset,
        end_block_entry_id, end_offset, source_text, context_snapshot, support_level,
        anchor_status, introduced_at, difficulty, elapsed_days, scheduled_days, learning_steps,
        reps, lapses, state, due_at
      ) VALUES ('p-bad', 'plan-1', 0, 'b1', 0, 'b1', 2, 'text', 'ctx', 'full', 'anchored', now(),
        5.1, 2, 4, 1, 6, 1, 'review', now());
    `);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/incomplete FSRS card/);
  });

  it("aborts fail-loud when an active passage has no resolvable owner", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    // A plan with NO personal_entries facet -> ownerless.
    await pglite.exec(
      `INSERT INTO entries (id, type) VALUES ('plan-x', 'recitation_plan');
       INSERT INTO recitation_plans (entry_id, work_entry_id, phase)
         VALUES ('plan-x', 'work-1', 'learning');`
    );
    await seedActivePassage(pglite, "p-orphan", "plan-x", 0, activeCard);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/no resolvable owner/);
  });

  it("aborts fail-loud when a whole-Work row has no resolvable owner", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await pglite.exec(
      `INSERT INTO entries (id, type) VALUES ('plan-x', 'recitation_plan');
       INSERT INTO recitation_plans (entry_id, work_entry_id, phase)
         VALUES ('plan-x', 'work-1', 'learning');`
    );
    await seedWholeWork(pglite, "plan-x", wholeWorkCard);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/no resolvable owner/);
  });

  it("aborts fail-loud when a review targets a passage with no entries row", async () => {
    const pglite = new PGlite();
    await seedPreMigrationSchema(pglite);
    await seedPlan(pglite, "plan-1", "user-1");
    // A review whose passage Entry was never created -> dangling target.
    await pglite.exec(`
      INSERT INTO recitation_reviews (id, passage_entry_id, rating, cue_strength, reviewed_at)
        VALUES ('rv-x', 'ghost-passage', 'good', 'opening', now());
    `);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/dangling review target/);
  });
});
