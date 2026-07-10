CREATE TABLE "recitation_passages" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"plan_entry_id" text NOT NULL,
	"order_index" integer NOT NULL,
	"start_block_entry_id" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_block_entry_id" text NOT NULL,
	"end_offset" integer NOT NULL,
	"source_text" text NOT NULL,
	"context_snapshot" text NOT NULL,
	"anchor_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"learning_steps" integer NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" text NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recitation_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"passage_entry_id" text NOT NULL,
	"rating" text NOT NULL,
	"cue_strength" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD CONSTRAINT "recitation_passages_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD CONSTRAINT "recitation_passages_plan_entry_id_recitation_plans_entry_id_fk" FOREIGN KEY ("plan_entry_id") REFERENCES "public"."recitation_plans"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD CONSTRAINT "recitation_passages_start_block_entry_id_entries_id_fk" FOREIGN KEY ("start_block_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD CONSTRAINT "recitation_passages_end_block_entry_id_entries_id_fk" FOREIGN KEY ("end_block_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_reviews" ADD CONSTRAINT "recitation_reviews_passage_entry_id_recitation_passages_entry_id_fk" FOREIGN KEY ("passage_entry_id") REFERENCES "public"."recitation_passages"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recitation_passages_plan_order_idx" ON "recitation_passages" USING btree ("plan_entry_id","order_index");--> statement-breakpoint
CREATE INDEX "recitation_passages_plan_due_idx" ON "recitation_passages" USING btree ("plan_entry_id","due_at");--> statement-breakpoint
CREATE INDEX "recitation_reviews_passage_idx" ON "recitation_reviews" USING btree ("passage_entry_id");