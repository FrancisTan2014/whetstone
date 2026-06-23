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
CREATE TABLE "work_meta" (
	"author_id" text NOT NULL,
	"entry_id" text PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"work_type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_meta" ADD CONSTRAINT "work_meta_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_meta" ADD CONSTRAINT "work_meta_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_meta_author_idx" ON "work_meta" USING btree ("author_id");