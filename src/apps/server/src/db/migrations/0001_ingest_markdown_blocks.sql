CREATE TABLE "blocks" (
	"block_type" text NOT NULL,
	"entry_id" text PRIMARY KEY NOT NULL,
	"mdast_json" jsonb NOT NULL,
	"order_index" integer NOT NULL,
	"plaintext" text NOT NULL,
	"reading_unit_entry_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_links" (
	"from_entry_id" text NOT NULL,
	"to_entry_id" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "entry_links_from_entry_id_to_entry_id_type_pk" PRIMARY KEY("from_entry_id","to_entry_id","type")
);
--> statement-breakpoint
CREATE TABLE "reading_units" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"order_index" integer NOT NULL,
	"title" text,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_sources" (
	"file_name" text,
	"file_path" text,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"source_text" text,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_reading_unit_entry_id_entries_id_fk" FOREIGN KEY ("reading_unit_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_from_entry_id_entries_id_fk" FOREIGN KEY ("from_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_to_entry_id_entries_id_fk" FOREIGN KEY ("to_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_units" ADD CONSTRAINT "reading_units_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_units" ADD CONSTRAINT "reading_units_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sources" ADD CONSTRAINT "work_sources_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_reading_unit_idx" ON "blocks" USING btree ("reading_unit_entry_id");--> statement-breakpoint
CREATE INDEX "reading_units_work_idx" ON "reading_units" USING btree ("work_entry_id");--> statement-breakpoint
CREATE INDEX "work_sources_work_idx" ON "work_sources" USING btree ("work_entry_id");