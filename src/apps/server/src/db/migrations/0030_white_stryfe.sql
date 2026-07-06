CREATE TABLE "proposal_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"timeline_entry_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision NOT NULL,
	"reason" text NOT NULL,
	"evidence_quote" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"duplicate_status" text NOT NULL,
	"related_recall_item_id" text,
	"novelty_reason" text,
	"model_name" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_candidate_id" text NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"feedback_tags_json" jsonb,
	"edited_payload_json" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"entry_date" text NOT NULL,
	"input_mode" text NOT NULL,
	"capture_source" text NOT NULL,
	"raw_input_text" text NOT NULL,
	"tidied_text" text,
	"language" text,
	"raw_audio_path" text
);
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "cue" text;--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "use_context" text;--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "tags_json" jsonb;--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "source_proposal_candidate_id" text;--> statement-breakpoint
ALTER TABLE "proposal_candidates" ADD CONSTRAINT "proposal_candidates_timeline_entry_id_timeline_entries_entry_id_fk" FOREIGN KEY ("timeline_entry_id") REFERENCES "public"."timeline_entries"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_candidates" ADD CONSTRAINT "proposal_candidates_related_recall_item_id_recall_items_id_fk" FOREIGN KEY ("related_recall_item_id") REFERENCES "public"."recall_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_reviews" ADD CONSTRAINT "proposal_reviews_proposal_candidate_id_proposal_candidates_id_fk" FOREIGN KEY ("proposal_candidate_id") REFERENCES "public"."proposal_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_candidates_user_idx" ON "proposal_candidates" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "proposal_candidates_timeline_entry_idx" ON "proposal_candidates" USING btree ("timeline_entry_id");--> statement-breakpoint
CREATE INDEX "proposal_reviews_candidate_idx" ON "proposal_reviews" USING btree ("proposal_candidate_id");--> statement-breakpoint
CREATE INDEX "timeline_entries_user_date_idx" ON "timeline_entries" USING btree ("user_id","entry_date");