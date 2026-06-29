CREATE TABLE "reader_preferences" (
	"reading_size" text NOT NULL,
	"theme" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL
);
