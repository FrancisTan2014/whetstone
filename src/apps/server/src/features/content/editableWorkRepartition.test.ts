import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { toEntryId, type EntryId } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { docBlocks, entries, noteAnchors, readingPositions, readingUnits } from "../../db/schema.js";
import {
  appendEditableWorkSection,
  initializeEditableWorkContent,
  reconcileEditableWorkContent,
  repartitionEditableWorkContent
} from "./editableWorkContent.js";

let db: DbClient;
let pglite: PGlite;
let sequence = 0;

const WORK_ID = toEntryId("work-1");
const createEntryId = (): string => `unit-${(sequence += 1)}`;

function para(text: string, id: string): DocumentNodeJSON {
  return { attrs: { id }, content: [{ text, type: "text" }], type: "paragraph" };
}

function heading(level: number, text: string, id: string): DocumentNodeJSON {
  return { attrs: { id, level }, content: [{ text, type: "text" }], type: "heading" };
}

function doc(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
  return { content: [...nodes], type: "doc" };
}

async function repartition(
  editedUnitEntryId: string,
  document: DocumentNodeJSON
): Promise<string> {
  return db.transaction(async (tx) => {
    const result = await repartitionEditableWorkContent(tx, {
      createEntryId,
      document,
      editedUnitEntryId,
      workEntryId: WORK_ID
    });
    return result.activeUnitEntryId;
  });
}

async function orderedUnits(): Promise<Array<{ entryId: string; orderIndex: number }>> {
  return db
    .select({ entryId: readingUnits.entryId, orderIndex: readingUnits.orderIndex })
    .from(readingUnits)
    .where(eq(readingUnits.workEntryId, WORK_ID))
    .orderBy(asc(readingUnits.orderIndex));
}

async function blocksOf(unitEntryId: string): Promise<string[]> {
  const rows = await db
    .select({ id: docBlocks.id, orderIndex: docBlocks.orderIndex })
    .from(docBlocks)
    .where(eq(docBlocks.readingUnitEntryId, unitEntryId))
    .orderBy(asc(docBlocks.orderIndex));
  return rows.map((row) => row.id);
}

async function entryExists(id: string): Promise<boolean> {
  return (await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id))).length === 1;
}

async function seedPosition(
  userId: string,
  unitEntryId: string,
  anchorBlockEntryId: string | null
): Promise<void> {
  await db.insert(readingPositions).values({
    anchorBlockEntryId,
    unitEntryId,
    userId,
    workEntryId: WORK_ID
  });
}

async function positionOf(
  userId: string
): Promise<{ anchorBlockEntryId: string | null; unitEntryId: string }> {
  const [row] = await db
    .select({
      anchorBlockEntryId: readingPositions.anchorBlockEntryId,
      unitEntryId: readingPositions.unitEntryId
    })
    .from(readingPositions)
    .where(eq(readingPositions.userId, userId));
  return row as { anchorBlockEntryId: string | null; unitEntryId: string };
}

// Build a Work with three sections and known block ids: a headless "Start" (u0 = [p-pre]), "Chapter One"
// (u1 = [h1, a1]), and "Chapter Two" (u2 = [h2, b1]). Returns the minted unit ids in order.
async function seedThreeSections(): Promise<Readonly<{ u0: string; u1: string; u2: string }>> {
  const { unitEntryId: u0 } = await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: WORK_ID, type: "work" });
    return initializeEditableWorkContent(tx, { createEntryId, workEntryId: WORK_ID });
  });
  await db.transaction(async (tx) =>
    reconcileEditableWorkContent(tx, {
      document: doc(para("Preface", "p-pre")),
      unitEntryId: u0,
      workEntryId: WORK_ID
    })
  );
  const { unitEntryId: u1 } = await db.transaction(async (tx) =>
    appendEditableWorkSection(tx, {
      createEntryId,
      document: doc(heading(1, "Chapter One", "h1"), para("A body", "a1")),
      orderIndex: 1,
      workEntryId: WORK_ID
    })
  );
  const { unitEntryId: u2 } = await db.transaction(async (tx) =>
    appendEditableWorkSection(tx, {
      createEntryId,
      document: doc(heading(1, "Chapter Two", "h2"), para("B body", "b1")),
      orderIndex: 2,
      workEntryId: WORK_ID
    })
  );
  return { u0, u1, u2 };
}

beforeEach(async () => {
  sequence = 0;
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("repartitionEditableWorkContent — structure", () => {
  it("splits a section at a new heading, preserves identity, and shifts following units", async () => {
    const { u0, u1, u2 } = await seedThreeSections();

    // Add a level-2 heading inside Chapter One so it splits into two bounded sections; the leading heading
    // keeps its id, so u1's identity survives and the new sub-section mints a fresh unit.
    const active = await repartition(
      u1,
      doc(
        heading(1, "Chapter One", "h1"),
        para("A body", "a1"),
        heading(2, "Sub", "h1a"),
        para("Sub body", "a2")
      )
    );

    const units = await orderedUnits();
    expect(units.map((unit) => unit.entryId)).toEqual([u0, u1, "unit-4", u2]);
    expect(units.map((unit) => unit.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(await blocksOf(u1)).toEqual(["h1", "a1"]);
    expect(await blocksOf("unit-4")).toEqual(["h1a", "a2"]);
    // The editor stays on the edited section (its first block still leads it).
    expect(active).toBe(u1);
    expect(await entryExists("a2")).toBe(true);
  });

  it("merges a section into the preceding unit when its leading heading is removed", async () => {
    const { u0, u1, u2 } = await seedThreeSections();

    // Chapter One loses its heading: its body merges into the preceding "Start" unit and u1 disappears.
    const active = await repartition(u1, doc(para("A body", "a1")));

    const units = await orderedUnits();
    expect(units.map((unit) => unit.entryId)).toEqual([u0, u2]);
    expect(units.map((unit) => unit.orderIndex)).toEqual([0, 1]);
    expect(await blocksOf(u0)).toEqual(["p-pre", "a1"]);
    // u1 and its removed heading block are gone; the editor follows the content into the merged unit.
    expect(await entryExists(u1)).toBe(false);
    expect(await entryExists("h1")).toBe(false);
    expect(active).toBe(u0);
  });

  it("edits the leading section in place without shifting or minting", async () => {
    const { u0, u1, u2 } = await seedThreeSections();

    const active = await repartition(u0, doc(para("Preface v2", "p-pre")));

    const units = await orderedUnits();
    expect(units.map((unit) => unit.entryId)).toEqual([u0, u1, u2]);
    expect(units.map((unit) => unit.orderIndex)).toEqual([0, 1, 2]);
    expect(await blocksOf(u0)).toEqual(["p-pre"]);
    expect(active).toBe(u0);
  });

  it("keeps the edited section's identity when its only block is replaced by a fresh id", async () => {
    const { u0 } = await seedThreeSections();

    const active = await repartition(u0, doc(para("Brand new", "p-new")));

    expect(active).toBe(u0);
    expect(await blocksOf(u0)).toEqual(["p-new"]);
    // The replaced block is gone; the unit id is preserved positionally.
    expect(await entryExists("p-pre")).toBe(false);
    expect(await entryExists("p-new")).toBe(true);
  });

  it("retains a removed block's entry when durable history still references it", async () => {
    const { u1 } = await seedThreeSections();
    await db.insert(entries).values({ id: "note-1", type: "note" });
    await db.insert(noteAnchors).values({
      blockEntryId: "a1",
      contextSnapshot: "ctx",
      endBlockEntryId: "a1",
      endOffset: null,
      noteEntryId: "note-1",
      selectedText: "text",
      startOffset: null
    });

    // Remove the body block a1 (a note anchors it) while keeping the heading.
    await repartition(u1, doc(heading(1, "Chapter One", "h1")));

    expect(await blocksOf(u1)).toEqual(["h1"]);
    // Its rendered row is gone but the Entry is retained so the note's anchor FK stays valid.
    expect(await db.select().from(docBlocks).where(eq(docBlocks.id, "a1"))).toHaveLength(0);
    expect(await entryExists("a1")).toBe(true);
  });
});

describe("repartitionEditableWorkContent — reading positions", () => {
  it("follows a surviving anchor into its new unit and leaves an unaffected top-of-unit alone", async () => {
    const { u2, u1 } = await seedThreeSections();
    await seedPosition("follower", u1, "a1");
    await seedPosition("top-survivor", u2, null);

    // Split u1 so a1 moves into a newly minted sub-unit.
    await repartition(
      u1,
      doc(heading(1, "Chapter One", "h1"), heading(2, "Sub", "h1a"), para("A body", "a1"))
    );

    expect(await positionOf("follower")).toEqual({ anchorBlockEntryId: "a1", unitEntryId: "unit-4" });
    // u2 was never in the affected span, so its top-of-unit position is untouched.
    expect(await positionOf("top-survivor")).toEqual({ anchorBlockEntryId: null, unitEntryId: u2 });
  });

  it("moves a top-of-unit position off a removed unit to its surviving fallback", async () => {
    const { u0, u1 } = await seedThreeSections();
    await seedPosition("top-of-removed", u1, null);

    await repartition(u1, doc(para("A body", "a1")));

    expect(await positionOf("top-of-removed")).toEqual({ anchorBlockEntryId: null, unitEntryId: u0 });
  });

  it("drops a deleted anchor but keeps the position on its still-surviving unit", async () => {
    const { u1 } = await seedThreeSections();
    await seedPosition("deleted-anchor", u1, "a1");

    // Remove a1 while u1 survives (its heading still leads it).
    await repartition(u1, doc(heading(1, "Chapter One", "h1")));

    expect(await positionOf("deleted-anchor")).toEqual({ anchorBlockEntryId: null, unitEntryId: u1 });
  });

  it("drops a deleted anchor and falls back to the span's first unit when its unit was removed", async () => {
    const { u0, u1 } = await seedThreeSections();
    await seedPosition("deleted-and-removed", u1, "a1");

    // Merge u1 left AND replace its body: u1 is removed and a1 is deleted.
    await repartition(u1, doc(para("Fresh body", "a-new")));

    expect(await positionOf("deleted-and-removed")).toEqual({
      anchorBlockEntryId: null,
      unitEntryId: u0
    });
  });

  it("leaves a position whose anchor is outside the affected span unchanged", async () => {
    const { u1, u2 } = await seedThreeSections();
    await seedPosition("outside", u2, "b1");

    await repartition(
      u1,
      doc(heading(1, "Chapter One", "h1"), heading(2, "Sub", "h1a"), para("A body", "a1"))
    );

    expect(await positionOf("outside")).toEqual({ anchorBlockEntryId: "b1", unitEntryId: u2 });
  });
});
