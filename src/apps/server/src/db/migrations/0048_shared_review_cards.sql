CREATE TABLE "review_cards" (
	"target_entry_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_retention" double precision NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"learning_steps" integer NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"target_entry_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_events_type_ck" CHECK (("review_events"."type" = 'rating' and "review_events"."rating" is not null) or ("review_events"."type" = 'reset' and "review_events"."rating" is null))
);
--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_target_entry_id_entries_id_fk" FOREIGN KEY ("target_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_target_entry_id_entries_id_fk" FOREIGN KEY ("target_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_cards_owner_status_due_idx" ON "review_cards" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "review_events_target_idx" ON "review_events" USING btree ("target_entry_id");--> statement-breakpoint
-- #617 data migration (fail-loud): move Memory's inline FSRS schedule into the shared review substrate.
-- A `scheduled` prompt is enrolled and MUST carry a complete FSRS card; refuse to migrate a partial one
-- rather than silently seeding a broken card.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_prompts"
		WHERE "lifecycle" = 'scheduled'
			AND (
				"stability" IS NULL OR "difficulty" IS NULL OR "elapsed_days" IS NULL
				OR "scheduled_days" IS NULL OR "learning_steps" IS NULL OR "reps" IS NULL
				OR "lapses" IS NULL OR "state" IS NULL OR "due_at" IS NULL
			)
	) THEN
		RAISE EXCEPTION 'Migration 0048 aborted: a scheduled memory_prompt has an incomplete FSRS card (a null scheduling column). Repair or delete the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Every enrolled prompt must have a resolvable owner (its note's personal_entries row). Refuse to migrate
-- an ownerless scheduled prompt rather than dropping it silently.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_prompts" p
		LEFT JOIN "personal_entries" pe ON pe."entry_id" = p."note_entry_id"
		WHERE p."lifecycle" = 'scheduled' AND pe."user_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0048 aborted: a scheduled memory_prompt has no resolvable owner (missing personal_entries for its note). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Seed one active review card per scheduled prompt, preserving its full FSRS state verbatim and stamping
-- the default requested retention (0.9) the seeding caller used before the substrate existed.
INSERT INTO "review_cards" (
	"target_entry_id", "user_id", "status", "requested_retention",
	"stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps",
	"reps", "lapses", "state", "due_at", "last_reviewed_at", "created_at", "updated_at"
)
SELECT
	p."entry_id", pe."user_id", 'active', 0.9,
	p."stability", p."difficulty", p."elapsed_days", p."scheduled_days", p."learning_steps",
	p."reps", p."lapses", p."state", p."due_at", p."last_reviewed_at", now(), now()
FROM "memory_prompts" p
JOIN "personal_entries" pe ON pe."entry_id" = p."note_entry_id"
WHERE p."lifecycle" = 'scheduled';--> statement-breakpoint
-- Move the append-only review log into review_events. Every past review is a `rating` event, keyed by the
-- prompt Entry id so the history survives even for a prompt later edited back to a draft (no card).
INSERT INTO "review_events" ("id", "target_entry_id", "type", "rating", "occurred_at")
SELECT "id", "prompt_entry_id", 'rating', "rating", "reviewed_at"
FROM "memory_prompt_reviews";--> statement-breakpoint
-- The lifecycle enum drops `scheduled` in favour of `ready` (content-completeness only); enrollment now
-- lives in review_cards. A `scheduled` prompt always had a revealable answer, so it becomes `ready`.
UPDATE "memory_prompts" SET "lifecycle" = 'ready' WHERE "lifecycle" = 'scheduled';--> statement-breakpoint
DROP INDEX "memory_prompts_due_idx";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "stability";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "difficulty";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "elapsed_days";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "scheduled_days";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "learning_steps";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "reps";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "lapses";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "last_reviewed_at";--> statement-breakpoint
ALTER TABLE "memory_prompts" DROP COLUMN "due_at";--> statement-breakpoint
DROP TABLE "memory_prompt_reviews" CASCADE;
