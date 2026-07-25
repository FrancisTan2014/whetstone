import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "@whetstone/domain";
import { MAX_WORK_CONTENT_REVISION } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, entries, workMeta } from "../../db/schema.js";
import { claimWorkContentRevision } from "./workContentRevision.js";

// #703 the origin-neutral Work content-revision fence. These tests exercise it against real `work_meta`
// rows with NO `personal_entries` facet — deliberately an imported Work — to prove content concurrency is
// a property of the Work, not of personal ownership, so an imported-Work correction command (#762) can
// reuse the same compare-and-set with no owner substrate.

let pglite: PGlite;
let db: DbClient;

async function seedImportedWork(entryId: string): Promise<EntryId> {
  await db.insert(authors).values({ id: `author-${entryId}`, name: entryId, nameKey: entryId });
  await db.insert(entries).values({ id: entryId, type: "work" });
  await db.insert(workMeta).values({
    authorId: `author-${entryId}`,
    entryId,
    language: "en",
    origin: "imported",
    title: `Work ${entryId}`,
    workType: "book"
  });

  return toEntryId(entryId);
}

async function storedRevision(entryId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ contentRevision: workMeta.contentRevision })
    .from(workMeta)
    .where(eq(workMeta.entryId, entryId));

  return row?.contentRevision;
}

async function personalEntryCount(entryId: string): Promise<number> {
  const rows = await pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM personal_entries WHERE entry_id = '${entryId}'`
  );

  return rows.rows[0]?.count ?? 0;
}

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("claimWorkContentRevision", () => {
  it("fences an imported canonical Work that has no personal_entries facet", async () => {
    const workEntryId = await seedImportedWork("imported-1");

    // A brand-new Work of any origin starts at the database default revision 0, with no ownership facet.
    expect(await storedRevision("imported-1")).toBe(0);
    expect(await personalEntryCount("imported-1")).toBe(0);

    const claimed = await claimWorkContentRevision(db, workEntryId, 0);

    expect(claimed).toBe(1);
    expect(await storedRevision("imported-1")).toBe(1);
    // The fence touched only content concurrency — it never invented an ownership row.
    expect(await personalEntryCount("imported-1")).toBe(0);
  });

  it("lets only one of two claims that loaded the same revision win", async () => {
    const workEntryId = await seedImportedWork("work-a");

    const first = await claimWorkContentRevision(db, workEntryId, 0);
    const second = await claimWorkContentRevision(db, workEntryId, 0);

    expect(first).toBe(1);
    expect(second).toBeUndefined();
    // The loser wrote nothing: the revision advanced exactly once.
    expect(await storedRevision("work-a")).toBe(1);
  });

  it("increments monotonically across successive claims", async () => {
    const workEntryId = await seedImportedWork("work-mono");

    expect(await claimWorkContentRevision(db, workEntryId, 0)).toBe(1);
    expect(await claimWorkContentRevision(db, workEntryId, 1)).toBe(2);
    expect(await claimWorkContentRevision(db, workEntryId, 2)).toBe(3);
    expect(await storedRevision("work-mono")).toBe(3);
  });

  it("treats a stale revision as a conflict and writes nothing", async () => {
    const workEntryId = await seedImportedWork("work-stale");
    await claimWorkContentRevision(db, workEntryId, 0);

    // The stored revision is now 1; a replay of the already-consumed token 0 matches no row.
    const replay = await claimWorkContentRevision(db, workEntryId, 0);
    // A future revision that does not yet exist is equally unclaimable.
    const ahead = await claimWorkContentRevision(db, workEntryId, 5);

    expect(replay).toBeUndefined();
    expect(ahead).toBeUndefined();
    expect(await storedRevision("work-stale")).toBe(1);
  });

  it("refuses a malformed revision without touching the row", async () => {
    const workEntryId = await seedImportedWork("work-bad");

    expect(await claimWorkContentRevision(db, workEntryId, -1)).toBeUndefined();
    expect(await claimWorkContentRevision(db, workEntryId, 1.5)).toBeUndefined();
    expect(await claimWorkContentRevision(db, workEntryId, Number.NaN)).toBeUndefined();
    // None of the refusals advanced the revision.
    expect(await storedRevision("work-bad")).toBe(0);
  });

  it("refuses an above-integer-range revision as a conflict, never a database error", async () => {
    const workEntryId = await seedImportedWork("work-huge");

    // A safe JS integer just past the signed 32-bit `integer` maximum would overflow the
    // `content_revision = expected` comparison and raise a database error; the fence must instead treat it
    // as a clean stale conflict (undefined) without touching the row (#703).
    const claimed = await claimWorkContentRevision(db, workEntryId, MAX_WORK_CONTENT_REVISION + 1);

    expect(claimed).toBeUndefined();
    expect(await storedRevision("work-huge")).toBe(0);
  });

  it("returns undefined for a missing Work", async () => {
    const claimed = await claimWorkContentRevision(db, toEntryId("work-missing"), 0);

    expect(claimed).toBeUndefined();
  });

  it("claims through an open transaction so the caller owns atomicity", async () => {
    const workEntryId = await seedImportedWork("work-tx");

    const claimed = await db.transaction((tx) => claimWorkContentRevision(tx, workEntryId, 0));

    expect(claimed).toBe(1);
    expect(await storedRevision("work-tx")).toBe(1);
  });

  it("only fences the addressed Work, never a sibling", async () => {
    const target = await seedImportedWork("work-target");
    await seedImportedWork("work-other");

    await claimWorkContentRevision(db, target, 0);

    expect(await storedRevision("work-target")).toBe(1);
    expect(await storedRevision("work-other")).toBe(0);
  });
});
