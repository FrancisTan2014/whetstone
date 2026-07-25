CREATE TABLE "card_creation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"draft_fingerprint" text NOT NULL,
	"candidate_note_ids" jsonb NOT NULL,
	"candidate_fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"decision" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_creation_attempts_decision_state_ck" CHECK (("card_creation_attempts"."state" = 'consumed' and "card_creation_attempts"."decision" is not null) or ("card_creation_attempts"."state" = 'pending' and "card_creation_attempts"."decision" is null))
);
--> statement-breakpoint
CREATE INDEX "card_creation_attempts_user_idx" ON "card_creation_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_creation_attempts_single_pending" ON "card_creation_attempts" USING btree ("user_id","submission_id") WHERE "card_creation_attempts"."state" = 'pending';