CREATE TABLE "diary_entries" (
	"created_at" timestamp with time zone NOT NULL,
	"entry_date" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"language" text,
	"text" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "diary_entries_user_date_idx" ON "diary_entries" USING btree ("user_id","entry_date");