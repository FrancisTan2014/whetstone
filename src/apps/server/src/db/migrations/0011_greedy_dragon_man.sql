CREATE TABLE "error_patterns" (
	"category" text NOT NULL,
	"count" integer NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "error_patterns_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "learner_profiles" (
	"focus" text NOT NULL,
	"level" text NOT NULL,
	"strengths_json" jsonb NOT NULL,
	"summary" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL,
	"weaknesses_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_outcomes" (
	"chunk_id" text,
	"error_category" text,
	"grade" integer NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_outcomes" ADD CONSTRAINT "turn_outcomes_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_outcomes_user_recorded_idx" ON "turn_outcomes" USING btree ("user_id","recorded_at");