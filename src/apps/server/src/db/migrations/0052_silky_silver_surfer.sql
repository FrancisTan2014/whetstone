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
-- Guard D (structure): a copied `body_doc` becomes a canonical note body, so it must satisfy the shared
-- document schema (`isValidDocument`, ProseMirror/Tiptap) — not merely be a `doc`-typed object with
-- non-blank text. SQL cannot run the schema's content expressions, but it CAN reject the structural
-- corruption that makes a row fail `isValidDocument`: walk every node and refuse an unknown node or mark
-- type, a non-array `content`, a text/leaf shape violation, or a malformed `marks` list. The node and mark
-- vocabularies are inlined FROZEN at this migration's point in time (they mirror
-- `documentNodeNames`/`documentMarkNames` in packages/document/src/nodes.ts as of #620); a migration is
-- immutable history validating the data that existed then, so freezing the vocabulary here is correct, not
-- drift. The authoritative runtime validator stays `isValidDocument`.
DO $$
BEGIN
	IF EXISTS (
		WITH RECURSIVE walk(node) AS (
			SELECT mn."body_doc" FROM "memory_notes" mn
			UNION ALL
			SELECT child.value
			FROM walk w
			CROSS JOIN LATERAL jsonb_array_elements(w.node -> 'content') AS child(value)
			WHERE jsonb_typeof(w.node) = 'object' AND jsonb_typeof(w.node -> 'content') = 'array'
		)
		SELECT 1 FROM walk w
		WHERE jsonb_typeof(w.node) IS DISTINCT FROM 'object'
			OR jsonb_typeof(w.node -> 'type') IS DISTINCT FROM 'string'
			OR (w.node ->> 'type') NOT IN (
				'doc', 'text', 'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'bulletList',
				'orderedList', 'tableCell', 'tableHeader', 'tableRow', 'table', 'image', 'figureCaption',
				'figure', 'definitionTerm', 'definitionDescription', 'definitionList', 'callout',
				'footnoteMarker', 'footnoteTarget', 'unknown'
			)
			OR ((w.node -> 'content') IS NOT NULL AND jsonb_typeof(w.node -> 'content') IS DISTINCT FROM 'array')
			OR ((w.node -> 'text') IS NOT NULL AND jsonb_typeof(w.node -> 'text') IS DISTINCT FROM 'string')
			OR ((w.node ->> 'type') = 'text'
				AND (jsonb_typeof(w.node -> 'text') IS DISTINCT FROM 'string' OR (w.node -> 'content') IS NOT NULL))
			OR ((w.node ->> 'type') IS DISTINCT FROM 'text' AND (w.node -> 'text') IS NOT NULL)
			OR ((w.node -> 'marks') IS NOT NULL AND (
				jsonb_typeof(w.node -> 'marks') IS DISTINCT FROM 'array'
				OR EXISTS (
					SELECT 1 FROM jsonb_array_elements(
						CASE WHEN jsonb_typeof(w.node -> 'marks') = 'array' THEN w.node -> 'marks' ELSE '[]'::jsonb END
					) AS m(value)
					WHERE jsonb_typeof(m.value) IS DISTINCT FROM 'object'
						OR jsonb_typeof(m.value -> 'type') IS DISTINCT FROM 'string'
						OR (m.value ->> 'type') NOT IN ('bold', 'italic', 'code', 'link')
				)
			))
	) THEN
		RAISE EXCEPTION 'Migration 0052 aborted: a memory_notes row has a structurally invalid body_doc (an unknown node or mark type, non-array content, or a malformed node) that would fail the shared document schema. Repair before migrating.';
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
