CREATE TABLE "toc_entries" (
	"depth" integer NOT NULL,
	"entry_id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"order_index" integer NOT NULL,
	"parent_entry_id" text,
	"target_anchor" text,
	"target_source_file" text,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "toc_entries" ADD CONSTRAINT "toc_entries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toc_entries" ADD CONSTRAINT "toc_entries_parent_entry_id_entries_id_fk" FOREIGN KEY ("parent_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toc_entries" ADD CONSTRAINT "toc_entries_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toc_entries_work_idx" ON "toc_entries" USING btree ("work_entry_id");