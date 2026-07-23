-- #724 canonical Work duplicate-candidate key. One database-owned normalization policy, shared by the
-- generated `work_meta.title_key` column and every runtime reader (JS and PostgreSQL Unicode lowercase
-- differ, so the key is computed in SQL and never duplicated in JavaScript). The key preserves punctuation,
-- symbols, digits, diacritics, and script so edition/language distinctions survive; it is candidate
-- evidence, never Work identity, so no uniqueness constraint is placed on it.

-- `work_title_key`: NFKC-normalize the title (folds full-width/compatibility forms and NBSP/ideographic
-- spaces to their canonical equivalents), remove every run of Unicode whitespace (NFKC has already mapped
-- the exotic spaces to plain ones), then database Unicode lowercase. A title that is blank after
-- normalization is rejected (fail loud) so no keyless row can slip in and the required column stays honest.
-- IMMUTABLE so it can back a STORED generated column.
CREATE OR REPLACE FUNCTION work_title_key(input text) RETURNS text AS $$
DECLARE
	cleaned text;
BEGIN
	cleaned := lower(regexp_replace(normalize(input, NFKC), '\s+', '', 'g'));
	IF cleaned = '' THEN
		RAISE EXCEPTION 'work title is blank after normalization';
	END IF;
	RETURN cleaned;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

-- Add the key as a GENERATED STORED column: PostgreSQL keys every existing Work from its DISPLAY title on
-- add (without rewriting the title) and recomputes it on every future write, so no Work writer can ever
-- desync the key from the title. `work_title_key` raises here if any legacy title is blank after
-- normalization, aborting the whole migration so a partial mutation can never be left behind.
ALTER TABLE "work_meta" ADD COLUMN "title_key" text GENERATED ALWAYS AS (work_title_key("title")) STORED NOT NULL;--> statement-breakpoint

-- #724 non-unique index over the canonical title key. Duplicate-candidate retrieval prefilters by title-key
-- length (a bounded window that is a complete superset of any fuzzy match), so an index on the key keeps
-- that scan cheap. Non-unique: many Works may legitimately share a title key.
CREATE INDEX "work_meta_title_key_idx" ON "work_meta" USING btree ("title_key");