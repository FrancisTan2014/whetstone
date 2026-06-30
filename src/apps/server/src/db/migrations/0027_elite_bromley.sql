CREATE TABLE "nudge_state" (
	"chunk_id" text NOT NULL,
	"dismissed_until" timestamp with time zone,
	"last_surfaced_at" timestamp with time zone,
	"user_id" text NOT NULL,
	CONSTRAINT "nudge_state_user_id_chunk_id_pk" PRIMARY KEY("user_id","chunk_id")
);
