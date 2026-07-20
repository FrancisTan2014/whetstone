CREATE TABLE "card_creation_receipts" (
	"user_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"note_entry_id" text NOT NULL,
	"prompt_entry_id" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_creation_receipts_user_id_submission_id_pk" PRIMARY KEY("user_id","submission_id")
);
