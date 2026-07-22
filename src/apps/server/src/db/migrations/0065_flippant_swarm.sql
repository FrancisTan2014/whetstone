CREATE TABLE "pdf_block_evidence" (
	"block_id" text PRIMARY KEY NOT NULL,
	"work_entry_id" text NOT NULL,
	"page" integer NOT NULL,
	"left" double precision,
	"top" double precision,
	"right" double precision,
	"bottom" double precision,
	"char_start" integer,
	"char_end" integer,
	"confidence" double precision,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pdf_import_publications" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"entered_title" text,
	"entered_author" text,
	"entered_language" text,
	"file_name" text NOT NULL,
	"work_entry_id" text,
	"ocr_required_pages" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "pdf_import_publications_result_ck" CHECK (not ("pdf_import_publications"."work_entry_id" is not null and "pdf_import_publications"."ocr_required_pages" is not null)),
	CONSTRAINT "pdf_import_publications_ocr_pages_ck" CHECK ("pdf_import_publications"."ocr_required_pages" is null or "pdf_import_publications"."ocr_required_pages" > 0)
);
--> statement-breakpoint
ALTER TABLE "pdf_block_evidence" ADD CONSTRAINT "pdf_block_evidence_block_id_doc_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."doc_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_block_evidence" ADD CONSTRAINT "pdf_block_evidence_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD CONSTRAINT "pdf_import_publications_attempt_id_pdf_import_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."pdf_import_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD CONSTRAINT "pdf_import_publications_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pdf_block_evidence_work_idx" ON "pdf_block_evidence" USING btree ("work_entry_id");