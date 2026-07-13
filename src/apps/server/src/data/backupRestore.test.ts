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
    INSERT INTO notes (answers_json, entry_id, markdown_body, template_id)
      VALUES ('{}', 'n1', 'a note body', NULL);
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
    const note = await verifyPglite.query<{ markdown_body: string }>(
      "select markdown_body from notes"
    );
    await verifyPglite.close();

    expect(authors.rows).toEqual([{ name: "Author One" }]);
    expect(work.rows).toEqual([{ title: "My Work" }]);
    expect(note.rows).toEqual([{ markdown_body: "a note body" }]);
  }, 60000);
});
