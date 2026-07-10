CREATE TABLE "recitation_plans" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"last_session_at" timestamp with time zone,
	"phase" text NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recitation_plans" ADD CONSTRAINT "recitation_plans_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recitation_plans" ADD CONSTRAINT "recitation_plans_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recitation_plans_work_idx" ON "recitation_plans" USING btree ("work_entry_id");