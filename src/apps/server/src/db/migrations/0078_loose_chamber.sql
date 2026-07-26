ALTER TABLE "card_creation_receipts" ADD COLUMN "channel" text DEFAULT 'ui' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_creation_receipts" ADD COLUMN "attempt_id" text;