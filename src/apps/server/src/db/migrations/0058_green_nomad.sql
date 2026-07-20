-- #694 canonical author identity. One database-owned identity policy, shared by this migration and
-- every runtime writer (JS and PostgreSQL Unicode lowercase differ, so the key must be computed in SQL).

-- `clean_author_name`: the cleaned DISPLAY name — Unicode NFKC (maps full-width/compatibility forms and
-- NBSP/ideographic spaces to their canonical equivalents), collapse each run of Unicode whitespace to one
-- ASCII space, then trim. Punctuation and diacritics are preserved.
CREATE OR REPLACE FUNCTION clean_author_name(input text) RETURNS text AS $$
	SELECT btrim(regexp_replace(normalize(input, NFKC), '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- `author_name_key`: the canonical KEY — database Unicode lowercase over the cleaned display name. A name
-- that is blank after cleaning is rejected (fail loud) so no keyless duplicate can slip in.
CREATE OR REPLACE FUNCTION author_name_key(input text) RETURNS text AS $$
DECLARE
	cleaned text;
BEGIN
	cleaned := clean_author_name(input);
	IF cleaned = '' THEN
		RAISE EXCEPTION 'author name is blank after cleaning';
	END IF;
	RETURN lower(cleaned);
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint

ALTER TABLE "authors" ADD COLUMN "name_key" text;--> statement-breakpoint

-- Fail-loud data migration: clean + key every named (non-self) author, merge duplicate keys onto one
-- deterministic survivor without losing any Work, and prove nothing was orphaned. `self-author:<userId>`
-- rows are left untouched (name_key stays NULL) so each owner-keyed "You" identity remains distinct.
-- Everything runs in one atomic statement: any blank legacy name raises inside the UPDATE and rolls the
-- whole migration step back, so a partial mutation can never be left behind.
DO $$
DECLARE
	orphaned bigint;
BEGIN
	-- Clean the display name and backfill its key for every named author. `author_name_key` raises here
	-- if a legacy name is blank after cleaning, aborting the whole block.
	UPDATE "authors"
	SET "name" = clean_author_name("name"),
		"name_key" = author_name_key("name")
	WHERE "id" NOT LIKE 'self-author:%';

	-- Deterministic survivor per duplicate key: the row referenced by the most Works, then the
	-- lexicographically smallest id. Captured once (ON COMMIT DROP) before any repoint so the choice is
	-- stable regardless of later mutation.
	CREATE TEMP TABLE author_survivors ON COMMIT DROP AS
	SELECT DISTINCT ON (a."name_key")
		a."name_key" AS name_key,
		a."id" AS survivor_id
	FROM "authors" a
	LEFT JOIN "work_meta" wm ON wm."author_id" = a."id"
	WHERE a."name_key" IS NOT NULL
	GROUP BY a."name_key", a."id"
	ORDER BY a."name_key", count(wm."entry_id") DESC, a."id" ASC;

	-- Repoint every Work off a redundant duplicate onto its survivor.
	UPDATE "work_meta" wm
	SET "author_id" = s.survivor_id
	FROM author_survivors s
	JOIN "authors" a ON a."name_key" = s.name_key
	WHERE wm."author_id" = a."id"
		AND a."id" <> s.survivor_id;

	-- Now that no Work references them, delete the redundant duplicate rows.
	DELETE FROM "authors" a
	USING author_survivors s
	WHERE a."name_key" = s.name_key
		AND a."id" <> s.survivor_id;

	-- Prove no Work was orphaned by the remap/delete before the unique index is created.
	SELECT count(*) INTO orphaned
	FROM "work_meta" wm
	LEFT JOIN "authors" a ON a."id" = wm."author_id"
	WHERE a."id" IS NULL;
	IF orphaned > 0 THEN
		RAISE EXCEPTION 'Migration 0058 aborted: % work_meta row(s) were orphaned during author dedup.', orphaned;
	END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX "authors_name_key_unique" ON "authors" USING btree ("name_key") WHERE "authors"."name_key" is not null;