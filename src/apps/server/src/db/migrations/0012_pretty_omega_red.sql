ALTER TABLE "cases" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "brief_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_brief_key_idx" ON "cases" USING btree ("brief_key");