import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { sha256Hex } from "./archive.js";
import { backupData } from "./backup.js";
import { resolveDataRoots } from "./dataRoots.js";
import { readVersionInfo } from "./metadata.js";
import { restoreData } from "./restore.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `whetstone-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

const sourceFileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
const imageFileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6, 5]);

async function seedDatabase(pglite: PGlite): Promise<void> {
  await runMigrations(pglite);
  const sourceSha = sha256Hex(sourceFileBytes);
  await pglite.exec(`
    INSERT INTO authors (id, name) VALUES ('a1', 'Author One');
    INSERT INTO entries (id, type) VALUES ('w1', 'work');
    INSERT INTO work_meta (author_id, entry_id, language, title, work_type)
      VALUES ('a1', 'w1', 'en', 'My Work', 'book');
    INSERT INTO work_sources (id, file_name, file_path, kind, sha256, source_text, work_entry_id)
      VALUES ('src1', 'my.pdf', 'w1source.pdf', 'upload', '${sourceSha}', NULL, 'w1');
    INSERT INTO entries (id, type) VALUES ('n1', 'note');
    INSERT INTO notes (body_doc, body_text, capture_source, entry_id, kind)
      VALUES ('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a note body"}]}]}', 'a note body', 'reader', 'n1', 'note');
    INSERT INTO entries (id, type) VALUES ('p-cn', 'memory_prompt'), ('p-er', 'memory_prompt'), ('p-lc', 'memory_prompt');
    INSERT INTO memory_prompts (entry_id, note_entry_id, cue_doc, cue_text, answer_doc, answer_text, lifecycle, reveal_kind)
      VALUES
        ('p-cn', 'n1', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"cue cn"}]}]}', 'cue cn', NULL, NULL, 'ready', 'current_note'),
        ('p-er', 'n1', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"cue er"}]}]}', 'cue er', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"success check"}]}]}', 'success check', 'ready', 'expected_response'),
        ('p-lc', 'n1', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"cue lc"}]}]}', 'cue lc', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"legacy answer"}]}]}', 'legacy answer', 'ready', 'legacy_custom');
    INSERT INTO review_cards (target_entry_id, user_id, status, requested_retention, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, due_at)
      VALUES ('p-er', 'user-1', 'active', 0.9, 1, 5, 0, 0, 0, 0, 0, 'new', '2026-01-05T00:00:00.000Z');
    INSERT INTO review_events (id, target_entry_id, type, rating, occurred_at)
      VALUES ('be-1', 'p-er', 'rating', 'good', '2026-01-04T00:00:00.000Z'), ('be-2', 'p-er', 'reset', NULL, '2026-01-03T00:00:00.000Z');
  `);
}

describe("backup/restore round-trip", () => {
  it("backs up a persistent database with file roots, then restores it verified", async () => {
    const databaseDir = scratch("db");
    const sourcesDir = scratch("sources");
    const imagesDir = scratch("images");
    const outputDir = scratch("out");
    const outputPath = join(outputDir, "whetstone-backup.zip");

    // Seed a persistent database plus a source file and an image file on disk.
    writeFileSync(join(sourcesDir, "w1source.pdf"), sourceFileBytes);
    writeFileSync(join(imagesDir, "logo.png"), imageFileBytes);

    const seedPglite = new PGlite(databaseDir);
    await seedPglite.waitReady;
    await seedDatabase(seedPglite);

    const version = readVersionInfo();
    const backupSummary = await backupData({
      dumpDatabase: async () => {
        const dump = await seedPglite.dumpDataDir("gzip");
        return new Uint8Array(await dump.arrayBuffer());
      },
      roots: resolveDataRoots({ sourceFilesDir: sourcesDir, imageResourcesDir: imagesDir }),
      version,
      outputPath
    });
    await seedPglite.close();

    expect(backupSummary.roots).toEqual([
      {
        name: "sources",
        configuredPath: sourcesDir,
        present: true,
        fileCount: 1,
        totalBytes: sourceFileBytes.length
      },
      {
        name: "images",
        configuredPath: imagesDir,
        present: true,
        fileCount: 1,
        totalBytes: imageFileBytes.length
      }
    ]);

    // Restore into a brand-new, empty target that shares nothing with the original roots, proving
    // the round-trip reconstructs the data from the archive alone.
    const targetDir = join(scratch("restore"), "data");
    mkdirSync(targetDir, { recursive: true });
    const archive = new Uint8Array(readFileSync(outputPath));

    const restoreSummary = await restoreData({
      archive,
      targetDir,
      openDatabase: async (dbDir, dumpBytes) => {
        const pglite = new PGlite(dbDir, {
          loadDataDir: new Blob([dumpBytes as unknown as BlobPart])
        });
        await pglite.waitReady;
        return {
          query: (sql) => pglite.query(sql),
          migrate: () => runMigrations(pglite),
          close: () => pglite.close()
        };
      }
    });

    expect(restoreSummary.schemaVersion).toBe(version.schemaVersion);
    expect(restoreSummary.probe.checkedFiles).toBe(1);
    expect(restoreSummary.probe.entryCount).toBeGreaterThanOrEqual(2);

    // The restored file roots match the originals byte-for-byte.
    expect(
      sha256Hex(new Uint8Array(readFileSync(join(targetDir, "sources", "w1source.pdf"))))
    ).toBe(sha256Hex(sourceFileBytes));
    expect(sha256Hex(new Uint8Array(readFileSync(join(targetDir, "images", "logo.png"))))).toBe(
      sha256Hex(imageFileBytes)
    );

    // The restored database holds the seeded rows.
    const verifyPglite = new PGlite(join(targetDir, "database"));
    await verifyPglite.waitReady;
    const authors = await verifyPglite.query<{ name: string }>("select name from authors");
    const work = await verifyPglite.query<{ title: string }>("select title from work_meta");
    const note = await verifyPglite.query<{ body_text: string }>("select body_text from notes");
    const prompts = await verifyPglite.query<{ reveal_kind: string; answer_text: string | null }>(
      "select reveal_kind, answer_text from memory_prompts order by reveal_kind"
    );
    const cards = await verifyPglite.query<{ target_entry_id: string; state: string }>(
      "select target_entry_id, state from review_cards"
    );
    const events = await verifyPglite.query<{ type: string }>(
      "select type from review_events order by type"
    );
    await verifyPglite.close();

    expect(authors.rows).toEqual([{ name: "Author One" }]);
    expect(work.rows).toEqual([{ title: "My Work" }]);
    expect(note.rows).toEqual([{ body_text: "a note body" }]);
    // All three reveal kinds — including the new expected_response Success check — survive the round-trip.
    expect(prompts.rows).toEqual([
      { reveal_kind: "current_note", answer_text: null },
      { reveal_kind: "expected_response", answer_text: "success check" },
      { reveal_kind: "legacy_custom", answer_text: "legacy answer" }
    ]);
    expect(cards.rows).toEqual([{ target_entry_id: "p-er", state: "new" }]);
    expect(events.rows).toEqual([{ type: "rating" }, { type: "reset" }]);
  }, 60000);
});
