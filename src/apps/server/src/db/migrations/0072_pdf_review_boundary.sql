ALTER TABLE "pdf_import_attempts" DROP CONSTRAINT "pdf_import_attempts_state_ck";--> statement-breakpoint
ALTER TABLE "work_creation_attempts" ADD COLUMN "pdf_import_attempt_id" text;--> statement-breakpoint
ALTER TABLE "work_creation_attempts" ADD CONSTRAINT "work_creation_attempts_pdf_import_attempt_id_pdf_import_attempts_id_fk" FOREIGN KEY ("pdf_import_attempt_id") REFERENCES "public"."pdf_import_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_creation_attempts_single_active_pdf" ON "work_creation_attempts" USING btree ("pdf_import_attempt_id") WHERE "work_creation_attempts"."pdf_import_attempt_id" is not null and "work_creation_attempts"."state" in ('pending', 'finalizing');--> statement-breakpoint
ALTER TABLE "pdf_import_attempts" ADD CONSTRAINT "pdf_import_attempts_state_ck" CHECK ("pdf_import_attempts"."state" in ('queued', 'running', 'awaiting_review', 'converted', 'failed', 'cancelled', 'interrupted'));--> statement-breakpoint
ALTER TABLE "work_creation_attempts" ADD CONSTRAINT "work_creation_attempts_pdf_ref_ck" CHECK (("work_creation_attempts"."source_kind" = 'pdf') = ("work_creation_attempts"."pdf_import_attempt_id" is not null));--> statement-breakpoint
-- #750: migrate pre-existing converted-but-unpublished attempts into the new `awaiting_review` state so
-- that after this upgrade removes the auto-publish drain, none is stranded (never published) or would
-- silently auto-publish. Only attempts that carry a still-pending publication intent (a real upload begun
-- through beginPdfImport, no outcome yet) are moved; a converted attempt whose publication already
-- resolved (a Work or a typed refusal) stays converted, and a bare attempt with no intent stays converted.
UPDATE "pdf_import_attempts" SET "state" = 'awaiting_review'
WHERE "state" = 'converted'
  AND "id" IN (
    SELECT "attempt_id" FROM "pdf_import_publications"
    WHERE "work_entry_id" IS NULL
      AND "ocr_validation_failed_pages" IS NULL
      AND "no_content" IS NULL
      AND "unpreservable_images" IS NULL
  );