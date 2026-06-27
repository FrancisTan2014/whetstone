CREATE TABLE "session_summaries" (
	"average_grade" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"error_counts_json" jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"strong_turns" integer NOT NULL,
	"turn_count" integer NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_summaries_user_idx" ON "session_summaries" USING btree ("user_id","created_at");