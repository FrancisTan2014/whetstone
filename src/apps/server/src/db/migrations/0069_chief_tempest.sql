ALTER TABLE "pdf_import_publications" DROP CONSTRAINT "pdf_import_publications_result_ck";--> statement-breakpoint
ALTER TABLE "pdf_block_evidence" ADD COLUMN "ocr_engine" text;--> statement-breakpoint
ALTER TABLE "pdf_block_evidence" ADD COLUMN "ocr_language" text;--> statement-breakpoint
ALTER TABLE "pdf_import_attempts" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "pdf_import_attempts" ADD COLUMN "ocr_fingerprint" text;--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD COLUMN "ocr_language_not_enabled_pages" integer;--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD COLUMN "ocr_validation_failed_pages" integer;--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD CONSTRAINT "pdf_import_publications_ocr_lang_pages_ck" CHECK ("pdf_import_publications"."ocr_language_not_enabled_pages" is null or "pdf_import_publications"."ocr_language_not_enabled_pages" > 0);--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD CONSTRAINT "pdf_import_publications_ocr_validation_pages_ck" CHECK ("pdf_import_publications"."ocr_validation_failed_pages" is null or "pdf_import_publications"."ocr_validation_failed_pages" > 0);--> statement-breakpoint
ALTER TABLE "pdf_import_publications" ADD CONSTRAINT "pdf_import_publications_result_ck" CHECK (("pdf_import_publications"."work_entry_id" is not null)::int + ("pdf_import_publications"."ocr_language_not_enabled_pages" is not null)::int + ("pdf_import_publications"."ocr_validation_failed_pages" is not null)::int + ("pdf_import_publications"."no_content" is not null)::int + ("pdf_import_publications"."unpreservable_images" is not null)::int <= 1);