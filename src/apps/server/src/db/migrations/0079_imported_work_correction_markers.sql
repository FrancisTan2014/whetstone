ALTER TABLE "doc_blocks" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_meta" ADD COLUMN "manual_corrections_at" timestamp with time zone;