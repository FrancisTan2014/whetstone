CREATE TABLE "memory_notes" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"body_doc" jsonb NOT NULL,
	"body_text" text NOT NULL,
	"capture_source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_prompt_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt_entry_id" text NOT NULL,
	"rating" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_prompts" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"note_entry_id" text NOT NULL,
	"cue_doc" jsonb NOT NULL,
	"cue_text" text NOT NULL,
	"answer_doc" jsonb,
	"answer_text" text,
	"lifecycle" text NOT NULL,
	"chunk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stability" double precision,
	"difficulty" double precision,
	"elapsed_days" integer,
	"scheduled_days" integer,
	"learning_steps" integer,
	"reps" integer,
	"lapses" integer,
	"state" text,
	"last_reviewed_at" timestamp with time zone,
	"due_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_prompt_reviews" ADD CONSTRAINT "memory_prompt_reviews_prompt_entry_id_memory_prompts_entry_id_fk" FOREIGN KEY ("prompt_entry_id") REFERENCES "public"."memory_prompts"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_prompts" ADD CONSTRAINT "memory_prompts_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_prompts" ADD CONSTRAINT "memory_prompts_note_entry_id_entries_id_fk" FOREIGN KEY ("note_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_prompts" ADD CONSTRAINT "memory_prompts_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_prompt_reviews_prompt_idx" ON "memory_prompt_reviews" USING btree ("prompt_entry_id");--> statement-breakpoint
CREATE INDEX "memory_prompts_note_idx" ON "memory_prompts" USING btree ("note_entry_id");--> statement-breakpoint
CREATE INDEX "memory_prompts_chunk_idx" ON "memory_prompts" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "memory_prompts_due_idx" ON "memory_prompts" USING btree ("due_at");