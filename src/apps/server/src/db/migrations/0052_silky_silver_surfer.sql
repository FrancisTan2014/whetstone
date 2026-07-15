-- #620 data migration (fail-loud): unify Reader and Memory notes into ONE `notes` facet. Every
-- `memory_notes` row becomes a `notes` row with `kind = 'note'` under the SAME `entry_id`, so its
-- ownership (`personal_entries`), provenance (`derived_from`), prompt edges (`contains`), and the whole
-- Memory scheduling substrate (`memory_prompts` → `review_cards`/`review_events`) keep working untouched
-- because no id changes. The `entries.type` of each migrated row flips `memory_note` → `note`, the
-- `memory_prompts.note_entry_id` FK is repointed from `entries` to `notes`, and the now-empty
-- `memory_notes` table is dropped. It RAISES (aborts) BEFORE any write on an entry-type conflict, an id
-- collision, missing ownership, a malformed rich body, an invalid capture source, an orphan prompt, or a
-- broken provenance link rather than migrating partial or inconsistent data.

-- Guard A) Entry-type integrity: every `memory_note`-typed entry must have a `memory_notes` row, and
-- every `memory_notes` row's entry must be typed `memory_note`. Refuse a desynchronized pair.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "entries" e
		LEFT JOIN "memory_notes" mn ON mn."entry_id" = e."id"
		WHERE e."type" = 'memory_note' AND mn."entry_id" IS NULL
	) OR EXISTS (
		SELECT 1 FROM "memory_notes" mn
		JOIN "entries" e ON e."id" = mn."entry_id"
		WHERE e."type" <> 'memory_note'
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: entries.type and memory_notes are out of sync (a memory_note entry without a row, or a memory_notes row whose entry is not typed memory_note). Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard B) Id collision: no `memory_notes.entry_id` may already exist in `notes` (the migration inserts
-- under the same id, so a pre-existing note row would be a genuine conflict).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_notes" mn
		JOIN "notes" n ON n."entry_id" = mn."entry_id"
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_notes.entry_id already exists in notes. Resolve the id collision before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard C) Ownership: every `memory_notes.entry_id` must carry a `personal_entries` row, so the migrated
-- note stays owned and placed on the Timeline exactly as before.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_notes" mn
		LEFT JOIN "personal_entries" pe ON pe."entry_id" = mn."entry_id"
		WHERE pe."entry_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_notes row has no personal_entries ownership row. Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard D) Rich body integrity: `body_doc` must be a ProseMirror/Tiptap document object and `body_text`
-- must be non-blank, matching the `notes_kind_body_ck` invariant a `note` must satisfy.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_notes" mn
		WHERE jsonb_typeof(mn."body_doc") <> 'object'
			OR mn."body_doc" ->> 'type' IS DISTINCT FROM 'doc'
			OR btrim(mn."body_text") = ''
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_notes row has a malformed body_doc (not a doc object) or a blank body_text. Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard E) Capture source: must be one of the unified note capture sources.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_notes" mn
		WHERE mn."capture_source" NOT IN ('manual', 'reader', 'import', 'practice', 'tool')
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_notes row has an invalid capture_source. Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard F) Prompt integrity: every `memory_prompts.note_entry_id` must point to a real `memory_notes`
-- row, so no prompt is orphaned when the FK is repointed to `notes`.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_prompts" mp
		LEFT JOIN "memory_notes" mn ON mn."entry_id" = mp."note_entry_id"
		WHERE mn."entry_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_prompts row references a missing memory_notes owner. Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- Guard G) Provenance integrity: every `derived_from` link out of a migrated note must point to an
-- existing entry, so provenance survives the migration intact.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "entry_links" l
		JOIN "memory_notes" mn ON mn."entry_id" = l."from_entry_id"
		LEFT JOIN "entries" e ON e."id" = l."to_entry_id"
		WHERE l."type" = 'derived_from' AND e."id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a derived_from provenance link from a memory note points to a missing entry. Repair before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 1) Copy every memory note into the unified `notes` facet under the same entry_id, as a `kind = 'note'`
-- row carrying the rich body and capture source verbatim. Memory notes are never anchored.
INSERT INTO "notes" ("entry_id", "body_doc", "body_text", "capture_source", "kind")
SELECT mn."entry_id", mn."body_doc", mn."body_text", mn."capture_source", 'note'
FROM "memory_notes" mn;--> statement-breakpoint
-- 2) Flip each migrated entry's type so a Memory note is now the same first-class `note` Entry.
UPDATE "entries" SET "type" = 'note' WHERE "type" = 'memory_note';--> statement-breakpoint
-- 3) Repoint the prompt→note FK from `entries` to `notes` (the note now lives in `notes`), making an
-- orphan prompt structurally impossible.
ALTER TABLE "memory_prompts" DROP CONSTRAINT "memory_prompts_note_entry_id_entries_id_fk";--> statement-breakpoint
ALTER TABLE "memory_prompts" ADD CONSTRAINT "memory_prompts_note_entry_id_notes_entry_id_fk" FOREIGN KEY ("note_entry_id") REFERENCES "public"."notes"("entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 4) The separate Memory-note store is now redundant; drop it. All rows were copied above and every
-- dependant (prompts, links, ownership, scheduling) references the preserved entry ids.
DROP TABLE "memory_notes" CASCADE;
