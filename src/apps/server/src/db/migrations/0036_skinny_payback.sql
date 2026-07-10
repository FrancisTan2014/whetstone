CREATE TABLE "diary_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"body_doc" jsonb NOT NULL,
	"body_text" text NOT NULL,
	"language" text,
	"input_mode" text NOT NULL,
	"raw_audio_path" text,
	"raw_transcript" text,
	"tidied_text" text,
	"processing_status" text,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "personal_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_entries" ADD CONSTRAINT "personal_entries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_entries_user_occurred_idx" ON "personal_entries" USING btree ("user_id","occurred_at");