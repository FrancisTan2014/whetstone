-- Notes become user-owned (PRODUCT.md "Identity & ownership (v0)"). Add a non-null user_id,
-- backfilling existing rows to the v0 DEFAULT_USER_ID (see src/identity/currentUser.ts), then drop
-- the column default so future inserts must stamp the owner from the current-user provider.
ALTER TABLE "notes" ADD COLUMN "user_id" text DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "user_id" DROP DEFAULT;