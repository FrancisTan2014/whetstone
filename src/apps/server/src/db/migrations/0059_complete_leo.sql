-- #695 explicit Work content authority. Add the required `work_meta.origin` — `imported` (externally
-- sourced EPUB/PDF/Markdown, managed by re-ingestion), `manual` (learner-curated source, edited from the
-- Library), or `authored` (the learner's own writing). Origin is the single discriminator every creation,
-- query, and write path reads; provenance and ownership rows answer different questions and must never
-- double as the Work type.
--
-- Backfill classifies each existing Work from its provenance + ownership shape BEFORE the column is made
-- non-null, adds the current v0 user's ownership facet to migrated manual Works, and fails loud (aborting
-- the whole migration) on any contradictory or unrecoverable shape rather than guessing. Everything else
-- — Works, ReadingUnits, blocks, sources, notes, positions, Recitation links, history — is preserved
-- byte-for-byte.
ALTER TABLE "work_meta" ADD COLUMN "origin" text;--> statement-breakpoint

DO $$
DECLARE
	work_row record;
	has_manual boolean;
	has_upload boolean;
	has_owner boolean;
	has_content boolean;
	resolved text;
	-- One deterministic timestamp for every owner facet this migration seeds. We do NOT fabricate a
	-- historical source date; this simply records when the Work was brought under explicit ownership.
	seeded_at timestamptz := now();
BEGIN
	FOR work_row IN SELECT "entry_id" FROM "work_meta" LOOP
		has_manual := EXISTS (
			SELECT 1 FROM "work_sources"
			WHERE "work_entry_id" = work_row."entry_id" AND "kind" = 'manual'
		);
		has_upload := EXISTS (
			SELECT 1 FROM "work_sources"
			WHERE "work_entry_id" = work_row."entry_id" AND "kind" = 'upload'
		);
		has_owner := EXISTS (
			SELECT 1 FROM "personal_entries" WHERE "entry_id" = work_row."entry_id"
		);
		has_content := EXISTS (
			SELECT 1 FROM "reading_units" WHERE "work_entry_id" = work_row."entry_id"
		);

		IF has_manual AND has_upload THEN
			-- Two conflicting provenance authorities on one Work: which one owns its content is ambiguous,
			-- so refuse to guess and abort the migration for a human to resolve.
			RAISE EXCEPTION 'Migration 0059 aborted: work_meta % has both a manual and an upload source; its content authority is ambiguous and must be resolved by hand.', work_row."entry_id";
		ELSIF has_manual THEN
			resolved := 'manual';
		ELSIF has_upload THEN
			resolved := 'imported';
		ELSIF has_owner THEN
			-- No source but an ownership facet: learner-authored writing.
			resolved := 'authored';
		ELSIF NOT has_content THEN
			-- An empty shell with neither source nor ownership: no external source exists to preserve, and
			-- manual is the only recoverable editing path. This legacy empty-shell recovery is an
			-- intentional one-time rule, NOT ongoing inference (new failed uploads stay imported shells).
			resolved := 'manual';
		ELSE
			-- Non-empty content with no source and no ownership: its authority cannot be inferred. Abort
			-- rather than mislabel real content.
			RAISE EXCEPTION 'Migration 0059 aborted: work_meta % has content but neither a source nor an ownership facet; its content authority cannot be inferred and must be resolved by hand.', work_row."entry_id";
		END IF;

		UPDATE "work_meta" SET "origin" = resolved WHERE "entry_id" = work_row."entry_id";

		-- A migrated manual Work must carry the current v0 user's ownership/chronology facet so future
		-- manual read/write commands (origin='manual' + owner) resolve it. Only manual Works can reach here
		-- without an owner: authored already has one, imported never gets one. Seed one deterministic
		-- timestamp across occurred/created/updated.
		IF resolved = 'manual' AND NOT has_owner THEN
			INSERT INTO "personal_entries" ("entry_id", "user_id", "occurred_at", "created_at", "updated_at")
			VALUES (work_row."entry_id", '00000000-0000-0000-0000-000000000001', seeded_at, seeded_at, seeded_at);
		END IF;
	END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE "work_meta" ALTER COLUMN "origin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_meta" ADD CONSTRAINT "work_meta_origin_ck" CHECK ("work_meta"."origin" in ('imported', 'manual', 'authored'));