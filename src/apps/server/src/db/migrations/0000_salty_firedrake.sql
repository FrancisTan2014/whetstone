CREATE TABLE "authors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_links" (
	"from_entry_id" text NOT NULL,
	"link_type" text NOT NULL,
	"to_entry_id" text NOT NULL,
	CONSTRAINT "entry_links_from_entry_id_to_entry_id_link_type_pk" PRIMARY KEY("from_entry_id","to_entry_id","link_type")
);
--> statement-breakpoint
CREATE TABLE "reading_unit_meta" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"markdown_file_path" text NOT NULL,
	"order_index" integer NOT NULL,
	"title" text NOT NULL,
	"work_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_meta" (
	"author_id" text NOT NULL,
	"entry_id" text PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"work_type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_from_entry_id_entries_id_fk" FOREIGN KEY ("from_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_links" ADD CONSTRAINT "entry_links_to_entry_id_entries_id_fk" FOREIGN KEY ("to_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_unit_meta" ADD CONSTRAINT "reading_unit_meta_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_unit_meta" ADD CONSTRAINT "reading_unit_meta_work_id_entries_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_meta" ADD CONSTRAINT "work_meta_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_meta" ADD CONSTRAINT "work_meta_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "el_from_idx" ON "entry_links" USING btree ("from_entry_id");--> statement-breakpoint
CREATE INDEX "ru_work_order_idx" ON "reading_unit_meta" USING btree ("work_id","order_index");