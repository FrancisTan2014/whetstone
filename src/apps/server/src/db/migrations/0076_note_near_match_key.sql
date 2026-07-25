-- #713 index near-Note material. Add a `relaxed_key` — the note material NFKC-normalized with
-- renderer-equivalent quotes/apostrophes/dashes collapsed, whitespace collapsed, and ASCII case folded —
-- plus its code-point `relaxed_key_length`, as a length-banded lookup accelerator for "is this very
-- similar prose?". Both are only an accelerator: the full guarded projection recomputed from the body
-- always decides a candidate, and near matching writes nothing. The key is NULL for a bodyless `mark` and
-- for a `note` whose material is UNSUPPORTED for fuzzy matching (a single word, non-ASCII/mixed scripts,
-- links/code/structure, or out-of-band length).
--
-- Unlike the exact fingerprint, the pair constraint is added VALID immediately: the freshly-added columns
-- are all-NULL, which already satisfies "both NULL, or a note with both non-NULL", so no legacy row
-- violates it and no NOT VALID/backfill-validate dance is required. A one-time JS backfill
-- (`backfillNoteNearMatchKeys`) then fills eligible legacy note rows in a single transaction. No note
-- body, text, timestamp, provenance, prompt, card, schedule, link, or history row is rewritten here.
ALTER TABLE "notes" ADD COLUMN "relaxed_key" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "relaxed_key_length" integer;--> statement-breakpoint
CREATE INDEX "notes_relaxed_key_length_idx" ON "notes" USING btree ("relaxed_key_length");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_relaxed_key_pair_ck" CHECK (("notes"."relaxed_key" is null and "notes"."relaxed_key_length" is null) or ("notes"."kind" = 'note' and "notes"."relaxed_key" is not null and "notes"."relaxed_key_length" is not null));
