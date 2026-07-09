-- Retire the standalone `diary_entries` table into the shared Timeline store (#559): the Diary becomes
-- a `capture_source = "diary"` filtered view over `timeline_entries`. Move every existing diary row
-- first (preserving id, entry_date, created_at, language; copying its text into BOTH raw_input_text and
-- tidied_text so it displays identically), registering each id's owning Entry, then drop the old table.
INSERT INTO "entries" ("id", "type")
SELECT "id", 'timeline_entry' FROM "diary_entries";
--> statement-breakpoint
INSERT INTO "timeline_entries" (
  "entry_id", "user_id", "created_at", "entry_date", "input_mode", "capture_source",
  "raw_input_text", "tidied_text", "language", "raw_audio_path"
)
SELECT "id", "user_id", "created_at", "entry_date", 'voice', 'diary', "text", "text", "language", NULL
FROM "diary_entries";
--> statement-breakpoint
DROP TABLE "diary_entries" CASCADE;