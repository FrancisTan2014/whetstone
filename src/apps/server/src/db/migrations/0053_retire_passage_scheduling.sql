-- #643 data migration: retire passage/chain recitation scheduling. Direct Work-level maintenance REPLACES
-- the passage-introduction / division / chaining curriculum, so those targets must stop contributing due
-- work. Passage review_cards are PAUSED (not deleted), and NO passage/chain/introduction rows or their
-- append-only review_events are touched — that history is preserved read-only and auditable. Whole-Work
-- targets are the LIVE direct maintenance cards (#643) and are deliberately left untouched.

-- 1) Pause every active review card whose target is a recitation passage, so retired passages stop
-- surfacing as due work. Chains and introductions own no review cards, so nothing else needs pausing.
UPDATE "review_cards" SET "status" = 'paused', "updated_at" = now()
WHERE "status" = 'active'
	AND "target_entry_id" IN (SELECT "id" FROM "entries" WHERE "type" = 'recitation_passage');--> statement-breakpoint
-- 2) Fail loud if any active passage card survived the retirement, so a partial retirement can never
-- silently leave passage scheduling contributing to Today's due work.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "review_cards" rc
		JOIN "entries" e ON e."id" = rc."target_entry_id"
		WHERE rc."status" = 'active' AND e."type" = 'recitation_passage'
	) THEN
		RAISE EXCEPTION 'Migration 0053 aborted: an active recitation_passage review card survived retirement. Passage scheduling must be fully paused before completing.';
	END IF;
END $$;
