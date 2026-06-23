ALTER TABLE "blocks" ALTER COLUMN "reading_unit_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "deleted_at" timestamp with time zone;