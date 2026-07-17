-- #657 data migration (fail-loud): give every Memory prompt an explicit, persisted reveal discriminant
-- (`reveal_kind`) so a reveal never has to be inferred from the nullable answer columns. Every EXISTING
-- prompt is backfilled as `legacy_custom` — the historical shape whose reveal resolves the prompt's own
-- stored answer — WITHOUT comparing its answer to the note or guessing intent, preserving prompt ids,
-- note ids, cue/answer docs and text, lifecycle, chunk provenance, ownership, and creation times exactly.
-- The `current_note` shape (a prompt that stores no answer and resolves the live note body) is produced
-- only by later Notes enrollment/import; no existing row is silently converted to it. The migration
-- ABORTS before writing on an orphan/non-note target, an incoherent lifecycle/answer shape, or a review
-- card attached to a non-ready prompt, rather than backfilling a discriminant over invalid data.

-- 1) Add the discriminant nullable first, so the guards can run and the backfill can populate it before
-- it is constrained.
ALTER TABLE "memory_prompts" ADD COLUMN "reveal_kind" text;--> statement-breakpoint
-- 2a) Every prompt's target must be an existing note (`notes.kind = 'note'`); a prompt on a missing note
-- or on a bodyless `mark` has no revealable material, so refuse it rather than backfill a discriminant.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_prompts" p
		LEFT JOIN "notes" n ON n."entry_id" = p."note_entry_id"
		WHERE n."entry_id" IS NULL OR n."kind" <> 'note'
	) THEN
		RAISE EXCEPTION 'Migration 0054 aborted: a memory prompt targets a missing or non-note (mark) note. Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2b) Every existing prompt must already satisfy the legacy shape it is about to be labelled with: a
-- `ready` prompt has BOTH answer projections, a `draft` prompt has NEITHER. Refuse an incoherent
-- lifecycle/answer shape rather than stamp `legacy_custom` onto a row the new check would reject.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "memory_prompts"
		WHERE NOT (
			("lifecycle" = 'ready' AND "answer_doc" IS NOT NULL AND "answer_text" IS NOT NULL)
			OR ("lifecycle" = 'draft' AND "answer_doc" IS NULL AND "answer_text" IS NULL)
		)
	) THEN
		RAISE EXCEPTION 'Migration 0054 aborted: a memory prompt has an incoherent lifecycle/answer shape (ready without an answer, or draft with one). Repair the row before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 2c) A shared review card may only be attached to a `ready` prompt (a draft carries no revealable
-- answer and must not be enrolled). Refuse a card on a non-ready prompt rather than migrate a schedule
-- that should not exist.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "review_cards" c
		JOIN "memory_prompts" p ON p."entry_id" = c."target_entry_id"
		WHERE p."lifecycle" <> 'ready'
	) THEN
		RAISE EXCEPTION 'Migration 0054 aborted: a review card is attached to a non-ready memory prompt. Repair the schedule before migrating.';
	END IF;
END $$;--> statement-breakpoint
-- 3) Backfill every existing prompt as the legacy custom-reveal shape, byte-for-byte otherwise untouched.
UPDATE "memory_prompts" SET "reveal_kind" = 'legacy_custom' WHERE "reveal_kind" IS NULL;--> statement-breakpoint
-- 4) Every row now carries a discriminant; enforce it.
ALTER TABLE "memory_prompts" ALTER COLUMN "reveal_kind" SET NOT NULL;--> statement-breakpoint
-- 5) Enforce the two reveal shapes in the database: a current-note prompt is ready and answerless (its
-- reveal is the live note body); a ready legacy prompt has both answer projections; a draft legacy prompt
-- has neither.
ALTER TABLE "memory_prompts" ADD CONSTRAINT "memory_prompts_reveal_shape_ck" CHECK (("memory_prompts"."reveal_kind" = 'current_note' and "memory_prompts"."lifecycle" = 'ready' and "memory_prompts"."answer_doc" is null and "memory_prompts"."answer_text" is null) or ("memory_prompts"."reveal_kind" = 'legacy_custom' and "memory_prompts"."lifecycle" = 'ready' and "memory_prompts"."answer_doc" is not null and "memory_prompts"."answer_text" is not null) or ("memory_prompts"."reveal_kind" = 'legacy_custom' and "memory_prompts"."lifecycle" = 'draft' and "memory_prompts"."answer_doc" is null and "memory_prompts"."answer_text" is null));
