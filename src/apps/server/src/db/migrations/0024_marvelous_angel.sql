CREATE TABLE "doc_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"node_json" jsonb NOT NULL,
	"order_index" integer NOT NULL,
	"reading_unit_entry_id" text NOT NULL,
	"type" text NOT NULL,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_blocks" ADD CONSTRAINT "doc_blocks_reading_unit_entry_id_entries_id_fk" FOREIGN KEY ("reading_unit_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_blocks" ADD CONSTRAINT "doc_blocks_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_blocks_reading_unit_idx" ON "doc_blocks" USING btree ("reading_unit_entry_id");--> statement-breakpoint
CREATE INDEX "doc_blocks_work_idx" ON "doc_blocks" USING btree ("work_entry_id");