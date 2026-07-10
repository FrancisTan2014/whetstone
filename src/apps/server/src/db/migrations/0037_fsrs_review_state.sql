DELETE FROM "recall_reviews";
--> statement-breakpoint
DELETE FROM "recall_items";
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "stability" double precision NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "difficulty" double precision NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "elapsed_days" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "scheduled_days" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "learning_steps" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "reps" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" ADD COLUMN "state" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_reviews" ADD COLUMN "rating" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "recall_items" DROP COLUMN "ease_factor";
--> statement-breakpoint
ALTER TABLE "recall_items" DROP COLUMN "interval_days";
--> statement-breakpoint
ALTER TABLE "recall_items" DROP COLUMN "repetitions";
--> statement-breakpoint
ALTER TABLE "recall_reviews" DROP COLUMN "grade";
