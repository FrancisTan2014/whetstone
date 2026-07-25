-- #711 index exact Note material. Add a non-unique `material_fingerprint` — the SHA-256 (hex) of the
-- note body's canonical semantic projection — as a deterministic lookup accelerator for "is this the
-- same material?". It is only an accelerator: full projected-value equality always decides, so the
-- column is deliberately non-unique. A body-bearing `note` carries one; a bodyless `mark` carries none.
--
-- The shape constraint is added NOT VALID: it enforces every FUTURE insert/update immediately (so the
-- single note write boundary can never persist a note without a fingerprint or a mark with one), while
-- skipping the existing legacy rows that still hold NULL. A one-time JS backfill
-- (`backfillNoteMaterialFingerprints`) then composes the document-package projection to fill those
-- legacy note rows in a single transaction and VALIDATEs the constraint — aborting with no partial
-- backfill on any invalid or blank body. No note body, text, timestamp, provenance, prompt, card,
-- schedule, link, or history row is rewritten here.
ALTER TABLE "notes" ADD COLUMN "material_fingerprint" text;--> statement-breakpoint
CREATE INDEX "notes_material_fingerprint_idx" ON "notes" USING btree ("material_fingerprint");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_material_fingerprint_kind_ck" CHECK (("notes"."kind" = 'note' and "notes"."material_fingerprint" is not null) or ("notes"."kind" = 'mark' and "notes"."material_fingerprint" is null)) NOT VALID;
