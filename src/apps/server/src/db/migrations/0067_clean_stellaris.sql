CREATE TABLE "work_creation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"proposed_title" text NOT NULL,
	"proposed_author_id" text,
	"proposed_author_name" text NOT NULL,
	"proposed_language" text NOT NULL,
	"proposed_work_type" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_hash" text,
	"candidate_snapshot" jsonb,
	"candidate_fingerprint" text,
	"state" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"stage_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_creation_attempts_state_ck" CHECK ("work_creation_attempts"."state" in ('pending', 'finalizing', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "work_creation_attempts_source_kind_ck" CHECK ("work_creation_attempts"."source_kind" in ('manual', 'markdown', 'epub', 'pdf')),
	CONSTRAINT "work_creation_attempts_stage_kind_ck" CHECK ("work_creation_attempts"."stage_path" is null or "work_creation_attempts"."source_kind" in ('markdown', 'epub')),
	CONSTRAINT "work_creation_attempts_snapshot_ck" CHECK (("work_creation_attempts"."candidate_snapshot" is null) = ("work_creation_attempts"."candidate_fingerprint" is null)),
	CONSTRAINT "work_creation_attempts_revision_ck" CHECK ("work_creation_attempts"."revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX "work_creation_attempts_user_idx" ON "work_creation_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_creation_attempts_single_active" ON "work_creation_attempts" USING btree ("user_id") WHERE "work_creation_attempts"."state" in ('pending', 'finalizing');