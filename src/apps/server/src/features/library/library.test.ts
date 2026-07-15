import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors as authorsTable,
  blocks,
  cases,
  chunks,
  docBlocks,
  domains,
  entries,
  entryLinks,
  memoryPrompts,
  noteAnchors,
  notes,
  personalEntries,
  readingPositions,
  readingUnits,
  recitationChains,
  recitationPassages,
  recitationPlans,
  recitationReviewEvidence,
  recitationWholeWork,
  reviewCards,
  reviewEvents,
  tocEntries,
  workMeta,
  workSources
} from "../../db/schema.js";
import type { LibraryRouteDependencies } from "./libraryRoutes.js";
import { depositMemory } from "../memory/memoryCommands.js";
import { noteProvenanceEntryId } from "../memory/memoryQueries.js";
import { createServer } from "../../http/createServer.js";

type TestContext = Readonly<{
  db: DbClient;
  // Source-file relative paths the delete cascade asked to unlink, in order.
  deletedPaths: string[];
  // When set, the injected unlink throws this error for every path (to exercise the best-effort path).
  failUnlinkWith: { error: Error | undefined };
  // Structured unlink failures the command logged (best-effort path).
  unlinkFailures: Array<{ error: unknown; filePath: string }>;
  server: ReturnType<typeof createServer>;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let authorSequence = 0;
  let entrySequence = 0;
  const deletedPaths: string[] = [];
  const unlinkFailures: Array<{ error: unknown; filePath: string }> = [];
  const failUnlinkWith: { error: Error | undefined } = { error: undefined };

  const dependencies: LibraryRouteDependencies = {
    createAuthorId: () => `author-${(authorSequence += 1)}`,
    createEntryId: () => `work-${(entrySequence += 1)}`,
    db,
    deleteSourceFile: async (relativePath) => {
      deletedPaths.push(relativePath);
      if (failUnlinkWith.error !== undefined) {
        throw failUnlinkWith.error;
      }
    },
    logSourceUnlinkFailure: (info) => unlinkFailures.push(info)
  };

  return {
    db,
    deletedPaths,
    failUnlinkWith,
    unlinkFailures,
    server: createServer({ library: dependencies, logger: false })
  };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("library routes", () => {
  it("creates authors and lists them sorted by name", async () => {
    const second = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Zadie Smith" }
    });
    const first = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Octavia Butler" }
    });

    expect(second.statusCode).toBe(201);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ id: "author-2", name: "Octavia Butler" });

    const list = await context.server.inject({ method: "GET", url: "/api/authors" });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      authors: [
        { id: "author-2", name: "Octavia Butler" },
        { id: "author-1", name: "Zadie Smith" }
      ]
    });
  });

  it("creates a work with a new inline author and persists both", async () => {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        title: "Politics and the English Language",
        workType: "essay"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      author: { id: "author-1", name: "George Orwell" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Politics and the English Language",
        workType: "essay"
      }
    });

    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(authors.json()).toEqual({ authors: [{ id: "author-1", name: "George Orwell" }] });

    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.statusCode).toBe(200);
    expect(works.json()).toEqual({
      works: [
        {
          author: { id: "author-1", name: "George Orwell" },
          work: {
            authorId: "author-1",
            entryId: "work-1",
            language: "en",
            title: "Politics and the English Language",
            workType: "essay"
          }
        }
      ]
    });
  });

  it("creates a work for an existing author selected by id", async () => {
    const author = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Charles Dickens" }
    });
    const authorId = author.json().id as string;

    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { authorId, mode: "existing" },
        language: "en",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      author: { id: "author-1", name: "Charles Dickens" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    });
  });

  it("rejects a work that references a missing author", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { authorId: "missing-author", mode: "existing" },
        language: "en",
        title: "Orphan Work",
        workType: "book"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "author_not_found", authorId: "missing-author" });

    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.json()).toEqual({ works: [] });
  });

  it("rejects invalid author and work payloads at the boundary", async () => {
    const invalidAuthor = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "  " }
    });

    expect(invalidAuthor.statusCode).toBe(400);
    expect(invalidAuthor.json()).toEqual({ error: "invalid_request" });

    const invalidWork = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "x" },
        language: "en",
        title: "t",
        workType: "magazine"
      }
    });

    expect(invalidWork.statusCode).toBe(400);
    expect(invalidWork.json()).toEqual({ error: "invalid_request" });
  });

  it("returns empty lists before any data exists", async () => {
    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    const works = await context.server.inject({ method: "GET", url: "/api/works" });

    expect(authors.json()).toEqual({ authors: [] });
    expect(works.json()).toEqual({ works: [] });
  });
});

// Seed one fully-populated work ("work-1") plus a harvested chunk reference and a second untouched work
// ("work-2"), so a delete can assert both the cascade and the preservation guarantees.
async function seedWorkWithContent(db: DbClient): Promise<void> {
  await db.insert(authorsTable).values({ id: "author-1", name: "Author" });
  await db.insert(domains).values({ id: "dom-1", name: "Domain", orderIndex: 0, weight: 1 });
  await db.insert(cases).values({
    communicativeFunction: "fn",
    domainId: "dom-1",
    id: "case-1",
    orderIndex: 0,
    situation: "sit"
  });

  await db.insert(entries).values([
    { id: "work-1", type: "work" },
    { id: "unit-1", type: "reading_unit" },
    { id: "block-1", type: "block" },
    { id: "pmblock-1", type: "block" },
    { id: "toc-1", type: "toc_entry" },
    { id: "note-1", type: "note" },
    { id: "work-2", type: "work" }
  ]);
  await db.insert(workMeta).values([
    { authorId: "author-1", entryId: "work-1", language: "en", title: "Doomed", workType: "book" },
    { authorId: "author-1", entryId: "work-2", language: "en", title: "Kept", workType: "book" }
  ]);
  await db.insert(readingUnits).values({ entryId: "unit-1", orderIndex: 0, workEntryId: "work-1" });
  await db.insert(blocks).values({
    blockType: "paragraph",
    entryId: "block-1",
    mdastJson: {},
    orderIndex: 0,
    plaintext: "legacy",
    readingUnitEntryId: "unit-1",
    workEntryId: "work-1"
  });
  await db.insert(docBlocks).values({
    id: "pmblock-1",
    nodeJson: {},
    orderIndex: 0,
    plaintext: "pm",
    readingUnitEntryId: "unit-1",
    type: "paragraph",
    workEntryId: "work-1"
  });
  await db.insert(tocEntries).values({
    depth: 0,
    entryId: "toc-1",
    label: "Chapter",
    orderIndex: 0,
    workEntryId: "work-1"
  });
  await db.insert(workSources).values({
    fileName: "doomed.epub",
    filePath: "work-1.epub",
    id: "source-1",
    kind: "upload",
    sha256: "hash",
    workEntryId: "work-1"
  });
  await db.insert(notes).values({
    bodyDoc: createTextDocument("note"),
    bodyText: "note",
    captureSource: "reader",
    entryId: "note-1",
    kind: "note"
  });
  await db.insert(personalEntries).values({
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    entryId: "note-1",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    userId: "user-a"
  });
  await db.insert(noteAnchors).values({
    blockEntryId: "block-1",
    contextSnapshot: "ctx",
    endBlockEntryId: "block-1",
    noteEntryId: "note-1",
    selectedText: "sel"
  });
  await db.insert(entryLinks).values([
    { fromEntryId: "work-1", toEntryId: "unit-1", type: "contains" },
    { fromEntryId: "unit-1", toEntryId: "block-1", type: "contains" },
    { fromEntryId: "unit-1", toEntryId: "pmblock-1", type: "contains" },
    { fromEntryId: "note-1", toEntryId: "block-1", type: "annotates" }
  ]);
  await db.insert(readingPositions).values({
    anchorBlockEntryId: "block-1",
    unitEntryId: "unit-1",
    userId: "user-a",
    workEntryId: "work-1"
  });
  await db.insert(chunks).values({
    caseId: "case-1",
    id: "chunk-1",
    orderIndex: 0,
    sourceBlockEntryId: "block-1",
    text: "chunk"
  });
}

async function seedMemoriesDerivedFromWork(db: DbClient): Promise<ReadonlyArray<string>> {
  let sequence = 0;
  const createId = (): string => `memory-${(sequence += 1)}`;
  const noteIds: string[] = [];
  for (const [derivedFromEntryId, text] of [
    ["block-1", "from legacy block"],
    ["pmblock-1", "from document block"],
    ["note-1", "from reader note"]
  ] as const) {
    const deposit = await depositMemory(
      { createId, db },
      {
        captureSource: "reader",
        derivedFromEntryId,
        noteText: text,
        prompts: [{ answerText: text, cueText: text }]
      },
      "user-a",
      new Date("2026-01-01T00:00:00.000Z")
    );
    noteIds.push(deposit.note.noteId);
  }
  return noteIds;
}

async function rowsFor(db: DbClient): Promise<Record<string, number>> {
  const count = async (rows: Promise<ReadonlyArray<unknown>>): Promise<number> =>
    (await rows).length;
  return {
    blocks: await count(db.select().from(blocks).where(eq(blocks.workEntryId, "work-1"))),
    docBlocks: await count(db.select().from(docBlocks).where(eq(docBlocks.workEntryId, "work-1"))),
    noteAnchors: await count(
      db.select().from(noteAnchors).where(eq(noteAnchors.noteEntryId, "note-1"))
    ),
    notes: await count(db.select().from(notes).where(eq(notes.entryId, "note-1"))),
    personalEntries: await count(
      db.select().from(personalEntries).where(eq(personalEntries.entryId, "note-1"))
    ),
    readingPositions: await count(
      db.select().from(readingPositions).where(eq(readingPositions.workEntryId, "work-1"))
    ),
    readingUnits: await count(
      db.select().from(readingUnits).where(eq(readingUnits.workEntryId, "work-1"))
    ),
    tocEntries: await count(
      db.select().from(tocEntries).where(eq(tocEntries.workEntryId, "work-1"))
    ),
    workMeta: await count(db.select().from(workMeta).where(eq(workMeta.entryId, "work-1"))),
    workSources: await count(
      db.select().from(workSources).where(eq(workSources.workEntryId, "work-1"))
    )
  };
}

describe("DELETE /api/works/:workEntryId", () => {
  it("cascades the work's owned content and returns 204", async () => {
    await seedWorkWithContent(context.db);

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    // Every owned table is empty for the deleted work.
    expect(await rowsFor(context.db)).toEqual({
      blocks: 0,
      docBlocks: 0,
      noteAnchors: 0,
      notes: 0,
      personalEntries: 0,
      readingPositions: 0,
      readingUnits: 0,
      tocEntries: 0,
      workMeta: 0,
      workSources: 0
    });

    // The owned entries rows are gone; the untouched second work's entry remains.
    const remainingEntries = (await context.db.select().from(entries)).map((row) => row.id).sort();
    expect(remainingEntries).toEqual(["work-2"]);

    // No containment/annotation edges linger.
    expect(await context.db.select().from(entryLinks)).toHaveLength(0);

    // The retained source file was unlinked.
    expect(context.deletedPaths).toEqual(["work-1.epub"]);
  });

  it("deletes a work a learner has adopted as a recitation routine, tearing the plan and its passages down (#577, #578)", async () => {
    await seedWorkWithContent(context.db);

    // Adopt work-1 as a recitation routine: an owned plan Entry + its personal_entries chronology facet
    // + the recitation_plans facet whose work_entry_id FK points at work-1.
    await context.db.insert(entries).values({ id: "recite-1", type: "recitation_plan" });
    await context.db.insert(personalEntries).values({
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      entryId: "recite-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      userId: "user-a"
    });
    await context.db.insert(recitationPlans).values({
      entryId: "recite-1",
      phase: "familiarizing",
      workEntryId: "work-1"
    });

    // Divide the plan into an active passage whose scheduling lives on the shared review-card substrate
    // (#618): the passage FKs the plan AND the Work's block Entry; its review card + append-only event +
    // cue-strength evidence FK the passage's target Entry — every edge the delete cascade must unwind.
    await context.db.insert(entries).values({ id: "passage-1", type: "recitation_passage" });
    await context.db.insert(recitationPassages).values({
      anchorStatus: "anchored",
      contextSnapshot: "Doomed",
      endBlockEntryId: "pmblock-1",
      endOffset: 2,
      entryId: "passage-1",
      introducedAt: new Date("2026-02-01T00:00:00.000Z"),
      orderIndex: 0,
      planEntryId: "recite-1",
      sourceText: "pm",
      startBlockEntryId: "pmblock-1",
      startOffset: 0
    });
    await context.db.insert(reviewCards).values({
      difficulty: 5,
      dueAt: new Date("2026-02-01T00:00:00.000Z"),
      elapsedDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      learningSteps: 0,
      reps: 1,
      requestedRetention: 0.95,
      scheduledDays: 0,
      stability: 1,
      state: "learning",
      status: "active",
      targetEntryId: "passage-1",
      userId: "user-a"
    });
    await context.db.insert(reviewEvents).values({
      id: "prev-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      rating: "good",
      targetEntryId: "passage-1",
      type: "rating"
    });
    await context.db.insert(recitationReviewEvidence).values({
      cueStrength: "opening",
      reviewEventId: "prev-1"
    });

    // The plan also owns a whole-Work aggregate: a separate target Entry linked to the plan by a
    // `contains` edge, recorded in recitation_whole_work, with its own card + event (no evidence — the
    // aggregate rating is passage-independent). And an open chain FKs the plan. All must unwind.
    await context.db.insert(entries).values({ id: "whole-1", type: "recitation_whole_work" });
    await context.db
      .insert(recitationWholeWork)
      .values({ entryId: "whole-1", planEntryId: "recite-1" });
    await context.db
      .insert(entryLinks)
      .values({ fromEntryId: "recite-1", toEntryId: "whole-1", type: "contains" });
    await context.db.insert(reviewCards).values({
      difficulty: 5,
      dueAt: new Date("2026-02-01T00:00:00.000Z"),
      elapsedDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      learningSteps: 0,
      reps: 1,
      requestedRetention: 0.95,
      scheduledDays: 0,
      stability: 1,
      state: "learning",
      status: "active",
      targetEntryId: "whole-1",
      userId: "user-a"
    });
    await context.db.insert(reviewEvents).values({
      id: "whole-ev-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      rating: "good",
      targetEntryId: "whole-1",
      type: "rating"
    });
    await context.db.insert(recitationChains).values({
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      endOrderIndex: 0,
      id: "chain-1",
      planEntryId: "recite-1",
      status: "active"
    });

    // Without the cascade this FK violates and the delete fails, stranding the Work in the Library.
    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });
    expect(response.statusCode).toBe(204);

    // The plan, its passages, the whole-Work target, chains, and all shared cards/events/evidence are
    // gone — with both plan facets and no orphaned entries; work-2 remains.
    expect(await context.db.select().from(recitationPlans)).toHaveLength(0);
    expect(await context.db.select().from(recitationPassages)).toHaveLength(0);
    expect(await context.db.select().from(recitationWholeWork)).toHaveLength(0);
    expect(await context.db.select().from(recitationChains)).toHaveLength(0);
    expect(await context.db.select().from(reviewCards)).toHaveLength(0);
    expect(await context.db.select().from(reviewEvents)).toHaveLength(0);
    expect(await context.db.select().from(recitationReviewEvidence)).toHaveLength(0);
    expect(
      await context.db.select().from(personalEntries).where(eq(personalEntries.entryId, "recite-1"))
    ).toHaveLength(0);
    const remainingEntries = (await context.db.select().from(entries)).map((row) => row.id).sort();
    expect(remainingEntries).toEqual(["work-2"]);
  });

  it("deletes an adopted plan that was never divided into passages (#577)", async () => {
    await seedWorkWithContent(context.db);

    await context.db.insert(entries).values({ id: "recite-1", type: "recitation_plan" });
    await context.db.insert(personalEntries).values({
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      entryId: "recite-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      userId: "user-a"
    });
    await context.db.insert(recitationPlans).values({
      entryId: "recite-1",
      phase: "familiarizing",
      workEntryId: "work-1"
    });

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    expect(response.statusCode).toBe(204);
    expect(await context.db.select().from(recitationPlans)).toHaveLength(0);
    const remainingEntries = (await context.db.select().from(entries)).map((row) => row.id).sort();
    expect(remainingEntries).toEqual(["work-2"]);
  });

  it("preserves Memory prompts and harvested chunks, detaching provenance to deleted content", async () => {
    await seedWorkWithContent(context.db);
    const noteIds = await seedMemoriesDerivedFromWork(context.db);

    await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    // The 3 Memory notes (unanchored, in the unified `notes` facet) survive the work deletion; the
    // work's own anchored reader note (`note-1`) is the only note the cascade removes.
    expect(await context.db.select().from(notes)).toHaveLength(3);
    expect(await context.db.select().from(memoryPrompts)).toHaveLength(3);
    for (const noteId of noteIds) {
      expect(await noteProvenanceEntryId(context.db, noteId)).toBeNull();
    }

    const chunkRows = await context.db.select().from(chunks);
    expect(chunkRows).toHaveLength(1);
    expect(chunkRows[0]?.sourceBlockEntryId).toBeNull();
  });

  it("returns 404 for an unknown work and touches nothing", async () => {
    await seedWorkWithContent(context.db);

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
    expect((await rowsFor(context.db)).workMeta).toBe(1);
    expect(context.deletedPaths).toEqual([]);
  });

  it("deletes an empty work (a failed/empty import) with no content", async () => {
    await context.db.insert(authorsTable).values({ id: "author-1", name: "Author" });
    await context.db.insert(entries).values({ id: "work-1", type: "work" });
    await context.db.insert(workMeta).values({
      authorId: "author-1",
      entryId: "work-1",
      language: "en",
      title: "Empty",
      workType: "book"
    });

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    expect(response.statusCode).toBe(204);
    expect(await context.db.select().from(workMeta)).toHaveLength(0);
    expect(await context.db.select().from(entries)).toHaveLength(0);
  });

  it("still deletes the work and logs when a source-file unlink fails (best-effort)", async () => {
    await seedWorkWithContent(context.db);
    context.failUnlinkWith.error = new Error("EACCES");

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    // The DB delete committed despite the filesystem error.
    expect(response.statusCode).toBe(204);
    expect((await rowsFor(context.db)).workMeta).toBe(0);
    // The failure was logged, not thrown.
    expect(context.unlinkFailures).toHaveLength(1);
    expect(context.unlinkFailures[0]?.filePath).toBe("work-1.epub");
  });
});
