ALTER TABLE "blocks" ADD COLUMN "work_entry_id" text;--> statement-breakpoint
UPDATE "blocks" SET "work_entry_id" = "reading_units"."work_entry_id" FROM "reading_units" WHERE "blocks"."reading_unit_entry_id" = "reading_units"."entry_id";--> statement-breakpoint
ALTER TABLE "blocks" ALTER COLUMN "work_entry_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_work_idx" ON "blocks" USING btree ("work_entry_id");
