CREATE TABLE "uploaded_source_claims" (
	"sha256" text PRIMARY KEY NOT NULL,
	"work_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploaded_source_claims" ADD CONSTRAINT "uploaded_source_claims_work_entry_id_entries_id_fk" FOREIGN KEY ("work_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill (#706): one deterministic single-owner claim per distinct uploaded-source hash. Only
-- imported Works' upload-kind bytes are claimed (manual source text never participates). When several
-- Works share the same hash, the lexicographically smallest Work id wins the claim; no Work, source,
-- content, or history row is merged or deleted — every existing row is preserved untouched.
INSERT INTO "uploaded_source_claims" ("sha256", "work_entry_id")
SELECT "ws"."sha256", MIN("ws"."work_entry_id")
FROM "work_sources" AS "ws"
JOIN "work_meta" AS "wm" ON "wm"."entry_id" = "ws"."work_entry_id"
WHERE "ws"."kind" = 'upload' AND "wm"."origin" = 'imported'
GROUP BY "ws"."sha256";