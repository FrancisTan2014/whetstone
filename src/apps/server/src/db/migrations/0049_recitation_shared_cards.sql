-- #618 data migration (fail-loud): move Recitation's inline FSRS schedule onto the shared review-card
-- substrate. Active passages and whole-Work targets become active `review_cards` at requested retention
-- 0.95, their review history moves to `review_events` (+ Recitation-owned cue-strength evidence), and the
-- inline FSRS/due columns are dropped. It refuses to migrate a partial card, an ownerless target, or a
-- dangling review rather than silently seeding a broken card or dropping data.

-- 1) The Recitation-owned evidence table (cue strength keyed 1:1 to a shared review event).
CREATE TABLE "recitation_review_evidence" (
	"review_event_id" text PRIMARY KEY NOT NULL,
	"cue_strength" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recitation_review_evidence" ADD CONSTRAINT "recitation_review_evidence_review_event_id_review_events_id_fk" FOREIGN KEY ("review_event_id") REFERENCES "public"."review_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 2a) An ACTIVE passage (introduced_at set) MUST carry a complete FSRS card; refuse a partial one.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "recitation_passages"
		WHERE "introduced_at" IS NOT NULL
			AND (
				"stability" IS NULL OR "difficulty" IS NULL OR "elapsed_days" IS NULL
				OR "scheduled_days" IS NULL OR "learning_steps" IS NULL OR "reps" IS NULL
				OR "lapses" IS NULL OR "state" IS NULL OR "due_at" IS NULL
			)
	) THEN
		RAISE EXCEPTION 'Migration 0049 aborted: an active recitation_passage has an incomplete FSRS card (a null scheduling column). Repair or delete the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2b) Every active passage must have a resolvable owner (its plan's personal_entries row).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "recitation_passages" p
		LEFT JOIN "personal_entries" pe ON pe."entry_id" = p."plan_entry_id"
		WHERE p."introduced_at" IS NOT NULL AND pe."user_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0049 aborted: an active recitation_passage has no resolvable owner (missing personal_entries for its plan). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 3) Seed one active 0.95 review card per ACTIVE passage, preserving its full FSRS state and due instant.
-- Queued passages (introduced_at null) get no card and are left untouched.
INSERT INTO "review_cards" (
	"target_entry_id", "user_id", "status", "requested_retention",
	"stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps",
	"reps", "lapses", "state", "due_at", "last_reviewed_at", "created_at", "updated_at"
)
SELECT
	p."entry_id", pe."user_id", 'active', 0.95,
	p."stability", p."difficulty", p."elapsed_days", p."scheduled_days", p."learning_steps",
	p."reps", p."lapses", p."state", p."due_at", p."last_reviewed_at", COALESCE(p."created_at", now()), now()
FROM "recitation_passages" p
JOIN "personal_entries" pe ON pe."entry_id" = p."plan_entry_id"
WHERE p."introduced_at" IS NOT NULL;--> statement-breakpoint
-- 4a) Every recitation review must target an existing passage Entry; refuse a dangling target.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "recitation_reviews" r
		LEFT JOIN "entries" e ON e."id" = r."passage_entry_id"
		WHERE e."id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0049 aborted: a recitation_reviews row has a dangling review target (no entries row for its passage). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 4b) Move the shared core of every review into review_events (id + passage target + rating + instant).
INSERT INTO "review_events" ("id", "target_entry_id", "type", "rating", "occurred_at")
SELECT "id", "passage_entry_id", 'rating', "rating", "reviewed_at"
FROM "recitation_reviews";--> statement-breakpoint
-- 4c) Preserve each review's cue strength in the Recitation-owned evidence row keyed by the event id.
INSERT INTO "recitation_review_evidence" ("review_event_id", "cue_strength")
SELECT "id", "cue_strength"
FROM "recitation_reviews";--> statement-breakpoint
-- 5a) Every existing whole-Work row must have a resolvable owner (its plan's personal_entries row).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "recitation_whole_work" ww
		LEFT JOIN "personal_entries" pe ON pe."entry_id" = ww."plan_entry_id"
		WHERE pe."user_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0049 aborted: a recitation_whole_work row has no resolvable owner (missing personal_entries for its plan). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 5b) Create a deterministic target Entry (plan_entry_id || ':whole_work') for every whole-Work row.
INSERT INTO "entries" ("id", "type")
SELECT "plan_entry_id" || ':whole_work', 'recitation_whole_work'
FROM "recitation_whole_work";--> statement-breakpoint
-- 5c) Seed one active 0.95 card for each whole-Work target, preserving its full FSRS state and due instant.
INSERT INTO "review_cards" (
	"target_entry_id", "user_id", "status", "requested_retention",
	"stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps",
	"reps", "lapses", "state", "due_at", "last_reviewed_at", "created_at", "updated_at"
)
SELECT
	ww."plan_entry_id" || ':whole_work', pe."user_id", 'active', 0.95,
	ww."stability", ww."difficulty", ww."elapsed_days", ww."scheduled_days", ww."learning_steps",
	ww."reps", ww."lapses", ww."state", ww."due_at", ww."last_reviewed_at", COALESCE(ww."created_at", now()), now()
FROM "recitation_whole_work" ww
JOIN "personal_entries" pe ON pe."entry_id" = ww."plan_entry_id";--> statement-breakpoint
-- 5d) Link each plan to its whole-Work target with the existing `contains` relation.
INSERT INTO "entry_links" ("from_entry_id", "to_entry_id", "type")
SELECT "plan_entry_id", "plan_entry_id" || ':whole_work', 'contains'
FROM "recitation_whole_work";--> statement-breakpoint
-- 6) Rebuild recitation_whole_work into its new shape (entry_id PK, plan_entry_id unique), dropping FSRS.
ALTER TABLE "recitation_whole_work" ADD COLUMN "entry_id" text;--> statement-breakpoint
UPDATE "recitation_whole_work" SET "entry_id" = "plan_entry_id" || ':whole_work';--> statement-breakpoint
ALTER TABLE "recitation_whole_work" ALTER COLUMN "entry_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP CONSTRAINT "recitation_whole_work_pkey";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" ADD CONSTRAINT "recitation_whole_work_pkey" PRIMARY KEY ("entry_id");--> statement-breakpoint
ALTER TABLE "recitation_whole_work" ADD CONSTRAINT "recitation_whole_work_plan_entry_id_unique" UNIQUE ("plan_entry_id");--> statement-breakpoint
ALTER TABLE "recitation_whole_work" ADD CONSTRAINT "recitation_whole_work_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "stability";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "difficulty";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "elapsed_days";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "scheduled_days";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "learning_steps";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "reps";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "lapses";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "last_reviewed_at";--> statement-breakpoint
ALTER TABLE "recitation_whole_work" DROP COLUMN "due_at";--> statement-breakpoint
-- 7) Strip the inline FSRS/due columns, the due index, and the lifecycle check from recitation_passages.
ALTER TABLE "recitation_passages" DROP CONSTRAINT "recitation_passages_lifecycle_ck";--> statement-breakpoint
DROP INDEX "recitation_passages_plan_due_idx";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "stability";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "difficulty";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "elapsed_days";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "scheduled_days";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "learning_steps";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "reps";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "lapses";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "last_reviewed_at";--> statement-breakpoint
ALTER TABLE "recitation_passages" DROP COLUMN "due_at";--> statement-breakpoint
-- 8) Drop the now-superseded recitation_reviews log (its data lives in review_events + evidence).
DROP TABLE "recitation_reviews" CASCADE;
