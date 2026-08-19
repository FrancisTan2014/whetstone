import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { toEntryId } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  blocks,
  cases,
  chunks,
  docBlocks,
  domains,
  entries,
  entryLinks,
  noteAnchors,
  readingPositions,
  readingUnits,
  recitationPassages,
  recitationPlans,
  reviewCards,
  reviewEvents,
  workSources
} from "../../db/schema.js";
import {
  initializeEditableWorkContent,
  insertEditableWorkSection,
  reconcileEditableWorkContent
} from "./editableWorkContent.js";

let db: DbClient;
let pglite: PGlite;
let sequence = 0;

const WORK_ID = toEntryId("work-1");
const createEntryId = (): string => `unit-${(sequence += 1)}`;

function para(text: string, id?: string): DocumentNodeJSON {
  const content = text.length === 0 ? undefined : [{ text, type: "text" }];
  const node: DocumentNodeJSON = { type: "paragraph", ...(content ? { content } : {}) };
  return id === undefined ? node : { ...node, attrs: { id } };
}

function doc(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
  return { content: [...nodes], type: "doc" };
}

function blockId(document: DocumentNodeJSON, index: number): string {
  const node = (document.content ?? [])[index];
  return String((node?.attrs as { id?: unknown } | undefined)?.id ?? "");
}

// Seed a bare Work Entry (the caller's responsibility), then initialize its content through the boundary.
async function seedWorkWithContent(): Promise<
  Readonly<{ document: DocumentNodeJSON; unitEntryId: string }>
> {
  return db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: WORK_ID, type: "work" });
    return initializeEditableWorkContent(tx, { createEntryId, workEntryId: WORK_ID });
  });
}

async function reconcile(
  unitEntryId: string,
  document: DocumentNodeJSON
): Promise<DocumentNodeJSON> {
  return db.transaction(async (tx) => {
    const result = await reconcileEditableWorkContent(tx, {
      document,
      unitEntryId,
      workEntryId: WORK_ID
    });
    return result.document;
  });
}

async function entryExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, id));
  return rows.length === 1;
}

async function seedNoteEntry(id: string): Promise<void> {
  await db.insert(entries).values({ id, type: "note" });
}

async function seedRecitationPlan(): Promise<void> {
  await db.insert(entries).values({ id: "plan-1", type: "recitation_plan" });
  await db
    .insert(recitationPlans)
    .values({ entryId: "plan-1", phase: "learning", workEntryId: WORK_ID });
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

describe("initializeEditableWorkContent", () => {
  it("writes one reading unit and one empty id-stamped paragraph with its entry and links", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();

    // The stamped document is a single empty paragraph carrying a stable id.
    expect(document.content).toHaveLength(1);
    expect(document.content?.[0]?.type).toBe("paragraph");
    const paragraphId = blockId(document, 0);
    expect(paragraphId).not.toBe("");

    // One reading unit exists for the work, ordered first with no source file.
    const units = await db.select().from(readingUnits).where(eq(readingUnits.workEntryId, WORK_ID));
    expect(units).toEqual([
      { entryId: unitEntryId, orderIndex: 0, sourceFile: null, title: null, workEntryId: WORK_ID }
    ]);
    expect(await entryExists(unitEntryId)).toBe(true);

    // One doc_blocks row is registered as an addressable block Entry under the unit.
    const storedBlocks = await db
      .select({
        id: docBlocks.id,
        orderIndex: docBlocks.orderIndex,
        readingUnitEntryId: docBlocks.readingUnitEntryId,
        type: docBlocks.type,
        workEntryId: docBlocks.workEntryId
      })
      .from(docBlocks)
      .where(eq(docBlocks.workEntryId, WORK_ID));
    expect(storedBlocks).toEqual([
      {
        id: paragraphId,
        orderIndex: 0,
        readingUnitEntryId: unitEntryId,
        type: "paragraph",
        workEntryId: WORK_ID
      }
    ]);
    expect(await entryExists(paragraphId)).toBe(true);

    // The containment graph links work -> unit -> block.
    const links = await db.select().from(entryLinks);
    expect(links).toContainEqual({
      fromEntryId: WORK_ID,
      toEntryId: unitEntryId,
      type: "contains"
    });
    expect(links).toContainEqual({
      fromEntryId: unitEntryId,
      toEntryId: paragraphId,
      type: "contains"
    });
  });

  it("creates no legacy mdast block and no work_sources row (clean canonical schema)", async () => {
    await seedWorkWithContent();

    expect(await db.select().from(blocks)).toHaveLength(0);
    expect(await db.select().from(workSources)).toHaveLength(0);
  });
});

describe("reconcileEditableWorkContent stable-id diff", () => {
  it("updates a surviving block in place, preserving its id", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);

    const saved = await reconcile(unitEntryId, doc(para("hello world", id0)));

    expect(blockId(saved, 0)).toBe(id0);
    const stored = await db
      .select({ id: docBlocks.id, plaintext: docBlocks.plaintext })
      .from(docBlocks)
      .where(eq(docBlocks.readingUnitEntryId, unitEntryId));
    expect(stored).toEqual([{ id: id0, plaintext: "hello world" }]);
  });

  it("inserts a genuinely new block with its entry and containment link", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);

    const saved = await reconcile(unitEntryId, doc(para("first", id0), para("second")));
    const id1 = blockId(saved, 1);

    expect(id1).not.toBe("");
    expect(id1).not.toBe(id0);
    expect(await entryExists(id1)).toBe(true);
    const links = await db.select().from(entryLinks).where(eq(entryLinks.toEntryId, id1));
    expect(links).toEqual([{ fromEntryId: unitEntryId, toEntryId: id1, type: "contains" }]);
  });

  it("removes an unreferenced block's rendered row, entry, and containment link", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);
    const withExtra = await reconcile(unitEntryId, doc(para("keep", id0), para("drop")));
    const droppedId = blockId(withExtra, 1);

    await reconcile(unitEntryId, doc(para("keep", id0)));

    expect(await db.select().from(docBlocks).where(eq(docBlocks.id, droppedId))).toHaveLength(0);
    expect(await entryExists(droppedId)).toBe(false);
    expect(
      await db.select().from(entryLinks).where(eq(entryLinks.toEntryId, droppedId))
    ).toHaveLength(0);
  });
});

describe("reconcileEditableWorkContent retention arms", () => {
  // Each arm seeds a durable reference to the removed block and asserts its Entry is retained (its
  // doc_blocks content is gone, but the referencing FK stays valid).
  async function removeSecondBlockWith(
    seedReference: (blockEntryId: string) => Promise<void>
  ): Promise<string> {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);
    // Two removals so at least one is genuinely deletable — the retained one must survive on its own merit.
    const three = await reconcile(
      unitEntryId,
      doc(para("keep", id0), para("referenced"), para("orphan"))
    );
    const referencedId = blockId(three, 1);
    const orphanId = blockId(three, 2);
    await seedReference(referencedId);

    await reconcile(unitEntryId, doc(para("keep", id0)));

    // The referenced block's content is gone but its Entry survives; the orphan is fully deleted.
    expect(await db.select().from(docBlocks).where(eq(docBlocks.id, referencedId))).toHaveLength(0);
    expect(await entryExists(referencedId)).toBe(true);
    expect(await entryExists(orphanId)).toBe(false);
    return referencedId;
  }

  it("keeps a block a note anchors by its start block", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await seedNoteEntry("note-start");
      await db.insert(noteAnchors).values({
        blockEntryId,
        contextSnapshot: "ctx",
        endBlockEntryId: blockEntryId,
        endOffset: null,
        noteEntryId: "note-start",
        selectedText: "text",
        startOffset: null
      });
    });
  });

  it("keeps a block that is a cross-block note span's end block", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await seedNoteEntry("note-end");
      await db.insert(entries).values({ id: "other-start", type: "block" });
      await db.insert(noteAnchors).values({
        blockEntryId: "other-start",
        contextSnapshot: "ctx",
        endBlockEntryId: blockEntryId,
        endOffset: null,
        noteEntryId: "note-end",
        selectedText: "text",
        startOffset: null
      });
    });
  });

  it("keeps a block that is a Recitation passage start endpoint", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await seedRecitationPlan();
      await db.insert(entries).values({ id: "passage-start", type: "recitation_passage" });
      await db.insert(recitationPassages).values({
        anchorStatus: "anchored",
        contextSnapshot: "ctx",
        endBlockEntryId: blockEntryId,
        endOffset: 1,
        entryId: "passage-start",
        orderIndex: 0,
        planEntryId: "plan-1",
        sourceText: "src",
        startBlockEntryId: blockEntryId,
        startOffset: 0
      });
    });
  });

  it("keeps a block that is a Recitation passage end endpoint", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await seedRecitationPlan();
      await db.insert(entries).values({ id: "start-block", type: "block" });
      await db.insert(entries).values({ id: "passage-end", type: "recitation_passage" });
      await db.insert(recitationPassages).values({
        anchorStatus: "anchored",
        contextSnapshot: "ctx",
        endBlockEntryId: blockEntryId,
        endOffset: 1,
        entryId: "passage-end",
        orderIndex: 0,
        planEntryId: "plan-1",
        sourceText: "src",
        startBlockEntryId: "start-block",
        startOffset: 0
      });
    });
  });

  it("keeps a block a saved reading position anchors", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await db.insert(readingPositions).values({
        anchorBlockEntryId: blockEntryId,
        unitEntryId: blockEntryId,
        userId: "user-1",
        workEntryId: WORK_ID
      });
    });
  });

  it("keeps a block that is a review-card target", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await db.insert(reviewCards).values({
        difficulty: 1,
        dueAt: new Date("2026-07-01T00:00:00.000Z"),
        elapsedDays: 0,
        lapses: 0,
        learningSteps: 0,
        reps: 0,
        requestedRetention: 0.9,
        scheduledDays: 0,
        stability: 1,
        state: "new",
        status: "active",
        targetEntryId: blockEntryId,
        userId: "user-1"
      });
    });
  });

  it("keeps a block that is a review-event target", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await db.insert(reviewEvents).values({
        id: "event-1",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        rating: "good",
        targetEntryId: blockEntryId,
        type: "rating"
      });
    });
  });

  it("keeps a block a durable annotates link points at", async () => {
    await removeSecondBlockWith(async (blockEntryId) => {
      await seedNoteEntry("annotator");
      await db
        .insert(entryLinks)
        .values({ fromEntryId: "annotator", toEntryId: blockEntryId, type: "annotates" });
    });
  });

  it("removes a block's content but deletes nothing when the only removal is retained", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);
    const two = await reconcile(unitEntryId, doc(para("keep", id0), para("referenced")));
    const referencedId = blockId(two, 1);
    await seedNoteEntry("note-solo");
    await db.insert(noteAnchors).values({
      blockEntryId: referencedId,
      contextSnapshot: "ctx",
      endBlockEntryId: referencedId,
      endOffset: null,
      noteEntryId: "note-solo",
      selectedText: "text",
      startOffset: null
    });

    // The sole removed block is durably referenced, so there is nothing deletable — the content row is
    // dropped but its Entry (and the note's FK) survives.
    await reconcile(unitEntryId, doc(para("keep", id0)));

    expect(await db.select().from(docBlocks).where(eq(docBlocks.id, referencedId))).toHaveLength(0);
    expect(await entryExists(referencedId)).toBe(true);
  });
});

describe("reconcileEditableWorkContent provenance detachment", () => {
  it("detaches a derived_from link and nulls a chunk source before deleting the block Entry", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);
    const two = await reconcile(unitEntryId, doc(para("keep", id0), para("harvested")));
    const harvestedId = blockId(two, 1);

    // A Memory note derived from the block, and a chunk harvested from it — both nullable provenance.
    await seedNoteEntry("memory-note");
    await db
      .insert(entryLinks)
      .values({ fromEntryId: "memory-note", toEntryId: harvestedId, type: "derived_from" });
    await db.insert(domains).values({ id: "dom-1", name: "d", orderIndex: 0, weight: 1 });
    await db.insert(cases).values({
      communicativeFunction: "fn",
      domainId: "dom-1",
      id: "case-1",
      orderIndex: 0,
      situation: "s"
    });
    await db.insert(chunks).values({
      caseId: "case-1",
      id: "chunk-1",
      orderIndex: 0,
      sourceBlockEntryId: harvestedId,
      text: "t"
    });

    await reconcile(unitEntryId, doc(para("keep", id0)));

    // The block Entry is deleted; its provenance is detached, not cascaded away.
    expect(await entryExists(harvestedId)).toBe(false);
    expect(await entryExists("memory-note")).toBe(true);
    expect(
      await db.select().from(entryLinks).where(eq(entryLinks.fromEntryId, "memory-note"))
    ).toHaveLength(0);
    const chunkRows = await db
      .select({ sourceBlockEntryId: chunks.sourceBlockEntryId })
      .from(chunks)
      .where(eq(chunks.id, "chunk-1"));
    expect(chunkRows).toEqual([{ sourceBlockEntryId: null }]);
  });
});

describe("reconcileEditableWorkContent transaction and input safety", () => {
  it("participates in the caller's transaction — a later failure rolls the reconcile back", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);

    await expect(
      db.transaction(async (tx) => {
        await reconcileEditableWorkContent(tx, {
          document: doc(para("uncommitted", id0), para("new one")),
          unitEntryId,
          workEntryId: WORK_ID
        });
        throw new Error("caller aborts");
      })
    ).rejects.toThrow("caller aborts");

    // Nothing from the aborted reconcile persisted: still exactly the initial single block.
    const stored = await db
      .select({ id: docBlocks.id, plaintext: docBlocks.plaintext })
      .from(docBlocks)
      .where(eq(docBlocks.readingUnitEntryId, unitEntryId));
    expect(stored).toEqual([{ id: id0, plaintext: "" }]);
  });

  it("does not mutate the caller's document argument and returns a fresh document", async () => {
    const { document, unitEntryId } = await seedWorkWithContent();
    const id0 = blockId(document, 0);

    const input = doc(para("immutable", id0), para("added"));
    const snapshot = structuredClone(input);

    const returned = await reconcile(unitEntryId, input);

    expect(input).toEqual(snapshot);
    expect(returned).not.toBe(input);
  });
});

describe("insertEditableWorkSection", () => {
  it("inserts a heading-led unit and shifts every following unit atomically", async () => {
    const { unitEntryId: firstUnit } = await seedWorkWithContent();

    const later = await db.transaction(async (tx) =>
      insertEditableWorkSection(tx, {
        createEntryId,
        headingLevel: 2,
        orderIndex: 1,
        workEntryId: WORK_ID
      })
    );
    const inserted = await db.transaction(async (tx) =>
      insertEditableWorkSection(tx, {
        createEntryId,
        headingLevel: 1,
        orderIndex: 1,
        workEntryId: WORK_ID
      })
    );

    // The new unit occupies index 1 and the existing later unit shifts to index 2 without changing identity.
    const units = await db
      .select()
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, WORK_ID))
      .orderBy(readingUnits.orderIndex);
    expect(units).toEqual([
      { entryId: firstUnit, orderIndex: 0, sourceFile: null, title: null, workEntryId: WORK_ID },
      {
        entryId: inserted.unitEntryId,
        orderIndex: 1,
        sourceFile: null,
        title: null,
        workEntryId: WORK_ID
      },
      {
        entryId: later.unitEntryId,
        orderIndex: 2,
        sourceFile: null,
        title: null,
        workEntryId: WORK_ID
      }
    ]);

    // The inserted section is seeded as the planned heading level plus an empty paragraph.
    const storedBlocks = await db
      .select({
        id: docBlocks.id,
        nodeJson: docBlocks.nodeJson,
        orderIndex: docBlocks.orderIndex,
        type: docBlocks.type
      })
      .from(docBlocks)
      .where(eq(docBlocks.readingUnitEntryId, inserted.unitEntryId))
      .orderBy(docBlocks.orderIndex);
    expect(storedBlocks.map((row) => row.type)).toEqual(["heading", "paragraph"]);
    expect((storedBlocks[0]?.nodeJson as DocumentNodeJSON).attrs?.level).toBe(1);
    expect(storedBlocks[0]?.id).toBe(blockId(inserted.document, 0));
    expect(storedBlocks[0]?.id).not.toBe("");

    // The new unit and its blocks are linked under the work.
    expect(await entryExists(inserted.unitEntryId)).toBe(true);
    const links = await db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.fromEntryId, inserted.unitEntryId));
    expect(links.map((link) => link.type)).toEqual(["contains", "contains"]);
  });
});
