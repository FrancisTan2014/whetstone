CREATE TABLE "reading_positions" (
	"anchor_block_entry_id" text,
	"unit_entry_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"work_entry_id" text NOT NULL,
	CONSTRAINT "reading_positions_user_id_work_entry_id_pk" PRIMARY KEY("user_id","work_entry_id")
);
--> statement-breakpoint
ALTER TABLE "reading_positions" ADD CONSTRAINT "reading_positions_anchor_block_entry_id_entries_id_fk" FOREIGN KEY ("anchor_block_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_positions" ADD CONSTRAINT "reading_positions_unit_entry_id_entries_id_fk" FOREIGN KEY ("unit_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_positions" ADD CONSTRAINT "reading_positions_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;