-- #619 data migration (fail-loud): replace note templates with one canonical rich note body. Each note
-- row becomes discriminated by `kind`: a `note` carries a rich ProseMirror/Tiptap `body_doc` plus its
-- server-derived readable `body_text`; a `mark` (the one-tap bodyless "Gem") carries neither. Every
-- existing templated note is migrated LOSSLESSLY from `note_templates.fields_json` + `notes.answers_json`
-- into that body, every null-template Gem becomes a `mark`, and all rows are backfilled to
-- `capture_source = 'reader'`. It RAISES (aborts) on a missing template, a malformed/unknown answer, or a
-- templated note with no recoverable content rather than discarding content or seeding an empty note.

-- 1) Add the new columns nullable first, so the transform can populate them before they are constrained.
ALTER TABLE "notes" ADD COLUMN "body_doc" jsonb;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "body_text" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "capture_source" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "kind" text;--> statement-breakpoint
-- 2a) A templated note's answers MUST be a JSON object (a string map keyed by field id); refuse anything
-- else (an array, a scalar, or a JSON null) rather than transform malformed data.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "notes"
		WHERE "template_id" IS NOT NULL AND jsonb_typeof("answers_json") <> 'object'
	) THEN
		RAISE EXCEPTION 'Migration 0051 aborted: a templated note has a malformed answers_json (not a JSON object). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2b) Every templated note must reference an existing template; refuse a dangling template_id.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "notes" n
		LEFT JOIN "note_templates" t ON t."id" = n."template_id"
		WHERE n."template_id" IS NOT NULL AND t."id" IS NULL
	) THEN
		RAISE EXCEPTION 'Migration 0051 aborted: a templated note references a missing note_templates row. Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2c) Every answer key must be a field id the note's template defines; refuse an unknown answer field.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "notes" n
		JOIN "note_templates" t ON t."id" = n."template_id"
		CROSS JOIN LATERAL jsonb_object_keys(n."answers_json") AS k(key)
		WHERE n."template_id" IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements(t."fields_json") AS fj
				WHERE fj.value ->> 'id' = k.key
			)
	) THEN
		RAISE EXCEPTION 'Migration 0051 aborted: a templated note has an answer for a field id its template does not define. Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2d) Every templated note must have at least one non-blank answer; refuse an unrecoverable empty note
-- rather than fall back to a success-shaped empty document.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "notes" n
		JOIN "note_templates" t ON t."id" = n."template_id"
		WHERE n."template_id" IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements(t."fields_json") AS fj
				WHERE (n."answers_json" ->> (fj.value ->> 'id')) IS NOT NULL
					AND btrim(n."answers_json" ->> (fj.value ->> 'id')) <> ''
			)
	) THEN
		RAISE EXCEPTION 'Migration 0051 aborted: a templated note has no recoverable non-blank content. Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 3) Every null-template row is a Gem (#255): a bodyless mark. It keeps its entry_id, anchors, ownership,
-- chronology, and links; only its content shape changes.
UPDATE "notes"
SET "kind" = 'mark', "capture_source" = 'reader', "body_doc" = NULL, "body_text" = NULL
WHERE "template_id" IS NULL;--> statement-breakpoint
-- 4) Migrate each templated note into a rich body, visiting fields in template order and keeping only
-- non-blank answers. `kept` is the ordered, non-blank (field label, learner answer) pairs per note; the
-- answer text is preserved EXACTLY (Unicode + line breaks) in a single text node, matching
-- `createTextDocument`. `body_doc` emits, per kept field, a label paragraph then an answer paragraph, in
-- field order; `body_text` is the space-joined readable projection (label ' ' answer, joined by ' '),
-- equal to `documentReadableText` over that paragraph list.
WITH kept AS (
	SELECT
		n."entry_id" AS entry_id,
		fj.ord AS ord,
		(fj.value ->> 'label') AS label,
		(n."answers_json" ->> (fj.value ->> 'id')) AS answer
	FROM "notes" n
	JOIN "note_templates" t ON t."id" = n."template_id"
	CROSS JOIN LATERAL jsonb_array_elements(t."fields_json") WITH ORDINALITY AS fj(value, ord)
	WHERE n."template_id" IS NOT NULL
		AND (n."answers_json" ->> (fj.value ->> 'id')) IS NOT NULL
		AND btrim(n."answers_json" ->> (fj.value ->> 'id')) <> ''
),
blocks AS (
	SELECT entry_id, ord, 0 AS sub,
		jsonb_build_object(
			'type', 'paragraph',
			'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', label))
		) AS block
	FROM kept
	UNION ALL
	SELECT entry_id, ord, 1 AS sub,
		jsonb_build_object(
			'type', 'paragraph',
			'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', answer))
		) AS block
	FROM kept
),
doc AS (
	SELECT entry_id,
		jsonb_build_object('type', 'doc', 'content', jsonb_agg(block ORDER BY ord, sub)) AS body_doc
	FROM blocks
	GROUP BY entry_id
),
projection AS (
	SELECT entry_id, string_agg(label || ' ' || answer, ' ' ORDER BY ord) AS body_text
	FROM kept
	GROUP BY entry_id
)
UPDATE "notes" n
SET "kind" = 'note',
	"capture_source" = 'reader',
	"body_doc" = doc.body_doc,
	"body_text" = projection.body_text
FROM doc
JOIN projection ON projection.entry_id = doc.entry_id
WHERE n."entry_id" = doc.entry_id;--> statement-breakpoint
-- 5) Every row now has a kind + capture_source; enforce them.
ALTER TABLE "notes" ALTER COLUMN "capture_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
-- 6) Drop the template plumbing: the FK, the legacy body/answer/template columns, and the table itself.
ALTER TABLE "notes" DROP CONSTRAINT "notes_template_id_note_templates_id_fk";--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "answers_json";--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "markdown_body";--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "template_id";--> statement-breakpoint
DROP TABLE "note_templates" CASCADE;--> statement-breakpoint
-- 7) Enforce the discriminated shape in the database: a note has both body columns, a mark has neither.
ALTER TABLE "notes" ADD CONSTRAINT "notes_kind_body_ck" CHECK (("notes"."kind" = 'note' and "notes"."body_doc" is not null and "notes"."body_text" is not null) or ("notes"."kind" = 'mark' and "notes"."body_doc" is null and "notes"."body_text" is null));
