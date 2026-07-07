CREATE TABLE "make_durable_backfill_scans" (
	"timeline_entry_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "make_durable_backfill_scans" ADD CONSTRAINT "make_durable_backfill_scans_timeline_entry_id_timeline_entries_entry_id_fk" FOREIGN KEY ("timeline_entry_id") REFERENCES "public"."timeline_entries"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "make_durable_backfill_scans_user_idx" ON "make_durable_backfill_scans" USING btree ("user_id");