ALTER TABLE "recitation_passages" ALTER COLUMN "stability" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "difficulty" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "elapsed_days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "scheduled_days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "learning_steps" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "reps" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "lapses" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ALTER COLUMN "due_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD COLUMN "introduced_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (#605): every passage created before this migration is an active, scheduled card (full FSRS),
-- so it is `active` in the new lifecycle. Stamp `introduced_at` from `created_at` to preserve its
-- learning history and due behavior before the lifecycle check constraint is enforced.
UPDATE "recitation_passages" SET "introduced_at" = "created_at" WHERE "introduced_at" IS NULL;--> statement-breakpoint
ALTER TABLE "recitation_passages" ADD CONSTRAINT "recitation_passages_lifecycle_ck" CHECK ((
        "recitation_passages"."introduced_at" is null and "recitation_passages"."stability" is null and "recitation_passages"."difficulty" is null
        and "recitation_passages"."elapsed_days" is null and "recitation_passages"."scheduled_days" is null
        and "recitation_passages"."learning_steps" is null and "recitation_passages"."reps" is null and "recitation_passages"."lapses" is null
        and "recitation_passages"."state" is null and "recitation_passages"."due_at" is null and "recitation_passages"."last_reviewed_at" is null
      ) or (
        "recitation_passages"."introduced_at" is not null and "recitation_passages"."stability" is not null
        and "recitation_passages"."difficulty" is not null and "recitation_passages"."elapsed_days" is not null
        and "recitation_passages"."scheduled_days" is not null and "recitation_passages"."learning_steps" is not null
        and "recitation_passages"."reps" is not null and "recitation_passages"."lapses" is not null and "recitation_passages"."state" is not null
        and "recitation_passages"."due_at" is not null
      ));