CREATE TABLE "recall_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"gloss" text,
	"provenance_entry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ease_factor" double precision NOT NULL,
	"interval_days" integer NOT NULL,
	"repetitions" integer NOT NULL,
	"lapses" integer NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recall_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"recall_item_id" text NOT NULL,
	"grade" integer NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_items" ADD CONSTRAINT "recall_items_provenance_entry_id_entries_id_fk" FOREIGN KEY ("provenance_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_reviews" ADD CONSTRAINT "recall_reviews_recall_item_id_recall_items_id_fk" FOREIGN KEY ("recall_item_id") REFERENCES "public"."recall_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_items_user_due_idx" ON "recall_items" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "recall_items_user_idx" ON "recall_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recall_reviews_item_idx" ON "recall_reviews" USING btree ("recall_item_id");