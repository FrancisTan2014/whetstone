CREATE TABLE "pdf_import_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"state" text NOT NULL,
	"run_token" text,
	"adapter_fingerprint" text,
	"stage_path" text,
	"total_pages" integer,
	"completed_pages" integer DEFAULT 0 NOT NULL,
	"total_ranges" integer,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	CONSTRAINT "pdf_import_attempts_state_ck" CHECK ("pdf_import_attempts"."state" in ('queued', 'running', 'converted', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "pdf_import_attempts_failure_ck" CHECK (("pdf_import_attempts"."state" = 'failed' and "pdf_import_attempts"."failure" is not null) or ("pdf_import_attempts"."state" <> 'failed' and "pdf_import_attempts"."failure" is null))
);
--> statement-breakpoint
CREATE TABLE "pdf_import_ranges" (
	"attempt_id" text NOT NULL,
	"range_index" integer NOT NULL,
	"start_page" integer NOT NULL,
	"end_page" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdf_import_ranges_attempt_id_range_index_pk" PRIMARY KEY("attempt_id","range_index")
);
--> statement-breakpoint
ALTER TABLE "pdf_import_ranges" ADD CONSTRAINT "pdf_import_ranges_attempt_id_pdf_import_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."pdf_import_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pdf_import_attempts_user_idx" ON "pdf_import_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_import_attempts_single_running" ON "pdf_import_attempts" USING btree ("state") WHERE "pdf_import_attempts"."state" = 'running';