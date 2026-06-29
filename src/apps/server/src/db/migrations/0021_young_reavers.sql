ALTER TABLE "note_anchors" ADD COLUMN "end_block_entry_id" text;--> statement-breakpoint
UPDATE "note_anchors" SET "end_block_entry_id" = "block_entry_id" WHERE "end_block_entry_id" IS NULL;--> statement-breakpoint
ALTER TABLE "note_anchors" ALTER COLUMN "end_block_entry_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "note_anchors" ADD CONSTRAINT "note_anchors_end_block_entry_id_entries_id_fk" FOREIGN KEY ("end_block_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;