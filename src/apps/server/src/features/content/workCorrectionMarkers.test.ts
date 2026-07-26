import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId, type BlockChangeSet } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, docBlocks, entries, readingUnits, workMeta } from "../../db/schema.js";
import { stampCorrectionMarkers } from "./workCorrectionMarkers.js";

// #762 the imported-Work correction marker boundary. These tests exercise it against real `work_meta` and
// `doc_blocks` rows to prove: the Work marker is set once on the first real change and never moved; the
// per-block marker is stamped on inserted and content-changed blocks only (never a mere reorder); and a
// no-op save (empty change set) stamps neither marker even though the caller may have advanced the revision.

const WORK_ID = "imported-1";
const UNIT_ID = "unit-1";

let pglite: PGlite;
let db: DbClient;

function changeSet(overrides: Partial<BlockChangeSet>): BlockChangeSet {
  return { changed: [], inserted: [], moved: [], removed: [], ...overrides };
}

async function seedWork(): Promise<void> {
  await db.insert(authors).values({ id: "author-1", name: "Imported", nameKey: "imported" });
  await db.insert(entries).values([
    { id: WORK_ID, type: "work" },
    { id: UNIT_ID, type: "reading_unit" }
  ]);
  await db.insert(workMeta).values({
    authorId: "author-1",
    entryId: WORK_ID,
    language: "en",
    origin: "imported",
    title: "Imported Work",
    workType: "book"
  });
  await db.insert(readingUnits).values({
    entryId: UNIT_ID,
    orderIndex: 0,
    sourceFile: null,
    title: null,
    workEntryId: WORK_ID
  });
}

async function seedBlocks(ids: readonly string[]): Promise<void> {
  await db.insert(entries).values(ids.map((id) => ({ id, type: "block" as const })));
  await db.insert(docBlocks).values(
    ids.map((id, index) => ({
      id,
      nodeJson: { attrs: { id }, type: "paragraph" },
      orderIndex: index,
      plaintext: id,
      readingUnitEntryId: UNIT_ID,
      type: "paragraph",
      workEntryId: WORK_ID
    }))
  );
}

async function workMarker(): Promise<Date | null> {
  const [row] = await db
    .select({ manualCorrectionsAt: workMeta.manualCorrectionsAt })
    .from(workMeta)
    .where(eq(workMeta.entryId, WORK_ID));
  return row?.manualCorrectionsAt ?? null;
}

async function blockMarkers(): Promise<Array<{ correctedAt: Date | null; id: string }>> {
  return db
    .select({ correctedAt: docBlocks.correctedAt, id: docBlocks.id })
    .from(docBlocks)
    .where(eq(docBlocks.workEntryId, WORK_ID))
    .orderBy(asc(docBlocks.orderIndex));
}

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  await seedWork();
});

afterEach(async () => {
  await pglite.close();
});

describe("stampCorrectionMarkers", () => {
  it("stamps the Work marker once and every inserted and changed block on a real correction", async () => {
    await seedBlocks(["b1", "b2", "b3"]);
    const now = new Date("2026-07-01T10:00:00.000Z");

    const recorded = await stampCorrectionMarkers(
      db,
      toEntryId(WORK_ID),
      changeSet({ changed: ["b2"], inserted: ["b3"] }),
      now
    );

    expect(recorded).toBe(true);
    expect(await workMarker()).toEqual(now);
    // Only the changed and inserted blocks carry a per-block marker; the untouched b1 stays null.
    expect(await blockMarkers()).toEqual([
      { correctedAt: null, id: "b1" },
      { correctedAt: now, id: "b2" },
      { correctedAt: now, id: "b3" }
    ]);
  });

  it("does not re-stamp a purely reordered or removed block", async () => {
    await seedBlocks(["b1", "b2"]);
    const now = new Date("2026-07-01T10:00:00.000Z");

    // A change set that only moved b1 and removed a now-gone block stamps neither surviving block, but a
    // move/removal is still a real change so the Work marker is set.
    const recorded = await stampCorrectionMarkers(
      db,
      toEntryId(WORK_ID),
      changeSet({ moved: ["b1"], removed: ["gone"] }),
      now
    );

    expect(recorded).toBe(true);
    expect(await workMarker()).toEqual(now);
    expect(await blockMarkers()).toEqual([
      { correctedAt: null, id: "b1" },
      { correctedAt: null, id: "b2" }
    ]);
  });

  it("keeps the Work marker at its first instant across a later correction", async () => {
    await seedBlocks(["b1", "b2"]);
    const first = new Date("2026-07-01T10:00:00.000Z");
    const later = new Date("2026-08-01T10:00:00.000Z");

    await stampCorrectionMarkers(db, toEntryId(WORK_ID), changeSet({ changed: ["b1"] }), first);
    await stampCorrectionMarkers(db, toEntryId(WORK_ID), changeSet({ changed: ["b2"] }), later);

    // The Work marker records the earliest correction and is never moved forward...
    expect(await workMarker()).toEqual(first);
    // ...while each block carries the instant of the correction that touched it.
    expect(await blockMarkers()).toEqual([
      { correctedAt: first, id: "b1" },
      { correctedAt: later, id: "b2" }
    ]);
  });

  it("stamps no marker for a no-op save even though the caller advanced the revision", async () => {
    await seedBlocks(["b1"]);
    const now = new Date("2026-07-01T10:00:00.000Z");

    const recorded = await stampCorrectionMarkers(db, toEntryId(WORK_ID), changeSet({}), now);

    expect(recorded).toBe(false);
    expect(await workMarker()).toBeNull();
    expect(await blockMarkers()).toEqual([{ correctedAt: null, id: "b1" }]);
  });
});
