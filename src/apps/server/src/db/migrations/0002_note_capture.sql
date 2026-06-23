CREATE TABLE "note_anchors" (
	"block_entry_id" text NOT NULL,
	"context_snapshot" text NOT NULL,
	"end_offset" integer,
	"note_entry_id" text PRIMARY KEY NOT NULL,
	"selected_text" text NOT NULL,
	"start_offset" integer
);
--> statement-breakpoint
CREATE TABLE "note_templates" (
	"fields_json" jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"answers_json" jsonb NOT NULL,
	"entry_id" text PRIMARY KEY NOT NULL,
	"markdown_body" text NOT NULL,
	"template_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_anchors" ADD CONSTRAINT "note_anchors_block_entry_id_entries_id_fk" FOREIGN KEY ("block_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_anchors" ADD CONSTRAINT "note_anchors_note_entry_id_entries_id_fk" FOREIGN KEY ("note_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_template_id_note_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."note_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_anchors_block_idx" ON "note_anchors" USING btree ("block_entry_id");