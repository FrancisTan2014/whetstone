CREATE TABLE "due_recitation_notification_state" (
	"last_notified_day_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL
);
