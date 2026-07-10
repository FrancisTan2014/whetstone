DROP TABLE "make_durable_backfill_scans" CASCADE;--> statement-breakpoint
DROP TABLE "proposal_candidates" CASCADE;--> statement-breakpoint
DROP TABLE "proposal_reviews" CASCADE;--> statement-breakpoint
DROP TABLE "timeline_entries" CASCADE;--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "user_id";