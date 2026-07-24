import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTextDocument, documentText, type DocumentNodeJSON } from "@whetstone/document";
import {
  RECALL_REQUEST_RETENTION,
  toEntryId,
  type WorkLanguage,
  type WorkType
} from "@whetstone/domain";

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
  pdfBlockEvidence,
  pdfImportAttempts,
  pdfImportPublications,
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
  uploadedSourceClaims,
  workMeta,
  workSources
} from "../../db/schema.js";
import { createWork } from "./libraryCommands.js";
import type { LibraryRouteDependencies } from "./libraryRoutes.js";
import { updateManualWorkContent, addManualWorkSection } from "./manualWorkContentCommands.js";
import { loadManualWorkForEditing, loadManualWorkUnit } from "./manualWorkContentQueries.js";
import { loadWorkStructure } from "../content/contentQueries.js";
import { insertCurrentNotePromptInTx, insertNoteInTx } from "../notes/noteCommands.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { createServer } from "../../http/createServer.js";

type TestContext = Readonly<{
  db: DbClient;
  // Source-file relative paths the delete cascade asked to unlink, in order.
  deletedPaths: string[];
  // When set, the injected unlink throws this error for every path (to exercise the best-effort path).
  failUnlinkWith: { error: Error | undefined };
  // The wired library command dependencies, exposed so a test can seed a manual Work through the
  // `createWork` command directly — the `POST /api/works` route only mints imported shells now (#749),
  // so manual seeds call the command with the same id/clock deps the route would.
  library: LibraryRouteDependencies;
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
    logSourceUnlinkFailure: (info) => unlinkFailures.push(info),
    now: () => new Date()
  };

  return {
    db,
    deletedPaths,
    failUnlinkWith,
    library: dependencies,
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
      ],
      cleanedQuery: "",
      exactMatchId: null
    });
  });

  it("resolves a canonically-equivalent author name to the existing row (200, no duplicate)", async () => {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Octavia Butler" }
    });
    // Same identity, differently typed: full-width + non-breaking spaces, padding, and mixed case.
    const resolved = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "  octavia\u3000BUTLER \u00a0" }
    });

    expect(created.statusCode).toBe(201);
    expect(resolved.statusCode).toBe(200);
    // The canonical name is preserved from the first insert; the variant does not overwrite it.
    expect(resolved.json()).toEqual({ id: "author-1", name: "Octavia Butler" });

    const list = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(list.json()).toEqual({
      authors: [{ id: "author-1", name: "Octavia Butler" }],
      cleanedQuery: "",
      exactMatchId: null
    });
  });

  it("searches authors by canonical substring and reports the exact match and cleaned query", async () => {
    await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Martin Kleppmann" }
    });
    await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Martin Fowler" }
    });

    const substring = await context.server.inject({
      method: "GET",
      url: "/api/authors?query=martin"
    });
    expect(substring.json()).toEqual({
      authors: [
        { id: "author-2", name: "Martin Fowler" },
        { id: "author-1", name: "Martin Kleppmann" }
      ],
      cleanedQuery: "martin",
      exactMatchId: null
    });

    // A case/width variant of a whole name resolves to the exact id so the UI suppresses "Add".
    const exact = await context.server.inject({
      method: "GET",
      url: `/api/authors?query=${encodeURIComponent("  martin\u3000FOWLER ")}`
    });
    expect(exact.json()).toEqual({
      authors: [{ id: "author-2", name: "Martin Fowler" }],
      cleanedQuery: "martin FOWLER",
      exactMatchId: "author-2"
    });
  });

  it("creates a Work whose new author name matches an existing one without duplicating the author", async () => {
    const first = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        origin: "imported",
        title: "Animal Farm",
        workType: "book"
      }
    });
    // The #694 bug: a second Work whose author differs only by case/width must reuse the author row.
    const second = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "george\u3000orwell" },
        language: "en",
        origin: "imported",
        title: "1984",
        workType: "book"
      }
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().work.authorId).toBe("author-1");

    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(authors.json()).toEqual({
      authors: [{ id: "author-1", name: "George Orwell" }],
      cleanedQuery: "",
      exactMatchId: null
    });
  });

  it("resolves concurrent creations of the same author name to a single row", async () => {
    const [a, b, c] = await Promise.all([
      context.server.inject({
        method: "POST",
        url: "/api/authors",
        payload: { name: "Ursula K. Le Guin" }
      }),
      context.server.inject({
        method: "POST",
        url: "/api/authors",
        payload: { name: "ursula k. le guin" }
      }),
      context.server.inject({
        method: "POST",
        url: "/api/authors",
        payload: { name: "URSULA K. LE GUIN" }
      })
    ]);

    const ids = [a, b, c].map((response) => response.json().id as string);
    expect(new Set(ids).size).toBe(1);

    const list = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(list.json().authors).toHaveLength(1);
  });

  it("creates a work with a new inline author and persists both", async () => {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        origin: "imported",
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
        origin: "imported",
        title: "Politics and the English Language",
        workType: "essay"
      }
    });

    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(authors.json()).toEqual({
      authors: [{ id: "author-1", name: "George Orwell" }],
      cleanedQuery: "",
      exactMatchId: null
    });

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
            origin: "imported",
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
        origin: "imported",
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
        origin: "imported",
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
        origin: "imported",
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
        origin: "imported",
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

    expect(authors.json()).toEqual({ authors: [], cleanedQuery: "", exactMatchId: null });
    expect(works.json()).toEqual({ works: [] });
  });

  it("rejects a Work create whose origin is authored (only the Writing path mints owned Works)", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "Sneaky Author" },
        language: "en",
        origin: "authored",
        title: "Not via the Library",
        workType: "book"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });

    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.json()).toEqual({ works: [] });
  });

  it("rejects a Work create that omits origin", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "Nameless Origin" },
        language: "en",
        title: "No origin",
        workType: "book"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses to create a manual Work through the legacy route (manual goes through review, #749)", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "Bypass Author" },
        language: "en",
        origin: "manual",
        title: "Unreviewed Manual Work",
        workType: "book"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "manual_requires_review" });

    // The refusal fires before any write, so a manual Work can never be committed — nor its author
    // created/resolved as a side effect — around the `POST /api/works/manual` duplicate-review boundary.
    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.json()).toEqual({ works: [] });
    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(authors.json()).toEqual({ authors: [], cleanedQuery: "", exactMatchId: null });
  });

  it("seeds the current user's ownership facet when a manual Work is created", async () => {
    // Manual Works are committed through the `createWork` command (invoked by the `POST /api/works/manual`
    // review front door, #749), never the legacy `POST /api/works` route. This asserts the command's
    // manual branch directly: stamping `origin = manual` seeds the caller's `personal_entries` ownership
    // facet in the same transaction.
    const created = await createWork(
      context.library,
      {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        origin: "manual",
        title: "Politics and the English Language",
        workType: "essay"
      },
      DEFAULT_USER_ID
    );

    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("expected the manual Work to be created");
    }
    expect(created.work.work.origin).toBe("manual");
    const entryId = created.work.work.entryId;

    const owners = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, entryId));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(DEFAULT_USER_ID);
  });

  it("leaves an imported Work shell unowned (no ownership facet is seeded)", async () => {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        origin: "imported",
        title: "Animal Farm",
        workType: "book"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().work.origin).toBe("imported");
    const entryId = created.json().work.entryId as string;

    const owners = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, entryId));
    expect(owners).toHaveLength(0);
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
    {
      authorId: "author-1",
      entryId: "work-1",
      language: "en",
      origin: "imported",
      title: "Doomed",
      workType: "book"
    },
    {
      authorId: "author-1",
      entryId: "work-2",
      language: "en",
      origin: "imported",
      title: "Kept",
      workType: "book"
    }
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

// The `derived_from` provenance target of a note (the source Entry it was made durable from), or null.
// Inlined from the retired memoryQueries; only this deletion test needs it.
async function noteProvenanceEntryId(db: DbClient, noteEntryId: string): Promise<string | null> {
  const rows = await db
    .select({ toEntryId: entryLinks.toEntryId })
    .from(entryLinks)
    .where(and(eq(entryLinks.fromEntryId, noteEntryId), eq(entryLinks.type, "derived_from")))
    .limit(1);
  return rows[0]?.toEntryId ?? null;
}

// Seed three Notes-owned prompts, each on an unanchored note derived from a piece of work-1 content, via
// the production note/prompt/card primitives — the shape the retired Memory deposit produced.
async function seedMemoriesDerivedFromWork(db: DbClient): Promise<ReadonlyArray<string>> {
  let sequence = 0;
  const now = new Date("2026-01-01T00:00:00.000Z");
  const noteIds: string[] = [];
  for (const [derivedFromEntryId, text] of [
    ["block-1", "from legacy block"],
    ["pmblock-1", "from document block"],
    ["note-1", "from reader note"]
  ] as const) {
    const noteId = `memory-note-${(sequence += 1)}`;
    const promptId = `memory-prompt-${(sequence += 1)}`;
    await db.transaction(async (tx) => {
      await insertNoteInTx(tx, {
        anchor: null,
        bodyDoc: createTextDocument(text),
        bodyText: text,
        captureSource: "reader",
        derivedFromEntryId,
        kind: "note",
        noteEntryId: noteId,
        now,
        userId: "user-a"
      });
      await insertCurrentNotePromptInTx(tx, {
        cueDoc: createTextDocument(text),
        cueText: text,
        noteEntryId: noteId,
        now,
        promptId
      });
      await seedReviewCard(tx, {
        now,
        requestedRetention: RECALL_REQUEST_RETENTION,
        targetEntryId: promptId,
        userId: "user-a"
      });
    });
    noteIds.push(noteId);
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
      origin: "imported",
      title: "Empty",
      workType: "book"
    });

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    expect(response.statusCode).toBe(204);
    expect(await context.db.select().from(workMeta)).toHaveLength(0);
    expect(await context.db.select().from(entries)).toHaveLength(0);
  });

  it("deletes a published PDF-imported work, tearing down its source claim and publication link (#702, #706)", async () => {
    // A born-digital PDF publishes into the same work-1 canonical content seed (unit + `doc_blocks` block)
    // and additionally leaves the import's data-integrity rows: a single-owner `uploaded_source_claims`
    // keyed by the uploaded bytes (so the same PDF reopens this Work), a `pdf_import_publications` link
    // recording what the converted attempt published, and per-block `pdf_block_evidence`. Every one of
    // these FKs the Work entry; without teardown the entries delete is rejected and the Work is stuck.
    await seedWorkWithContent(context.db);
    await context.db
      .insert(uploadedSourceClaims)
      .values({ sha256: "pdf-hash", workEntryId: "work-1" });
    await context.db.insert(pdfImportAttempts).values({
      id: "attempt-1",
      sourceHash: "pdf-hash",
      state: "converted",
      userId: "user-a"
    });
    await context.db.insert(pdfImportPublications).values({
      attemptId: "attempt-1",
      fileName: "doomed.pdf",
      workEntryId: "work-1"
    });
    await context.db.insert(pdfBlockEvidence).values({
      blockId: "pmblock-1",
      label: "text",
      page: 1,
      workEntryId: "work-1"
    });

    const response = await context.server.inject({ method: "DELETE", url: "/api/works/work-1" });

    // Before the fix this FK-violated on the entries delete and returned 500; the Work is now deletable.
    expect(response.statusCode).toBe(204);

    // The claim and the publication link that referenced the deleted Work are gone; the per-block evidence
    // cascaded away with its `doc_blocks` row. work-2 (untouched) still owns nothing PDF-related.
    expect(await context.db.select().from(uploadedSourceClaims)).toHaveLength(0);
    expect(await context.db.select().from(pdfImportPublications)).toHaveLength(0);
    expect(await context.db.select().from(pdfBlockEvidence)).toHaveLength(0);
    const remainingEntries = (await context.db.select().from(entries)).map((row) => row.id).sort();
    expect(remainingEntries).toEqual(["work-2"]);
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

describe("manual work editor (#720, sections #697)", () => {
  async function createManualWork(
    payload?: Partial<{ language: WorkLanguage; title: string; workType: WorkType }>
  ): Promise<string> {
    // The `POST /api/works` route no longer commits a manual Work (#749); its author-resolution +
    // canonical empty-document boundary is exercised through the `createWork` command, which is what the
    // `POST /api/works/manual` review front door commits with. Seed editor fixtures the same byte-less way.
    const created = await createWork(
      context.library,
      {
        author: { mode: "new", name: "George Orwell" },
        language: payload?.language ?? "en",
        origin: "manual",
        title: payload?.title ?? "Reading notes",
        workType: payload?.workType ?? "book"
      },
      DEFAULT_USER_ID
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("expected the manual Work fixture to be created");
    }
    return created.work.work.entryId;
  }

  async function createImportedWork(): Promise<string> {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "Imported Author" },
        language: "en",
        origin: "imported",
        title: "An upload shell",
        workType: "book"
      }
    });
    expect(created.statusCode).toBe(201);
    return created.json().work.entryId as string;
  }

  function paragraph(text: string): DocumentNodeJSON {
    return { content: [{ text, type: "text" }], type: "paragraph" };
  }

  function heading(level: number, text: string): DocumentNodeJSON {
    return { attrs: { level }, content: [{ text, type: "text" }], type: "heading" };
  }

  // The command dependencies for a direct (non-HTTP) call. `createEntryId` mints unique ids for an
  // appended section; the update path never mints, but the shared deps type requires it.
  function commandDeps(now: () => Date = () => new Date()): {
    createEntryId: () => string;
    db: DbClient;
    now: () => Date;
  } {
    let sequence = 0;
    return { createEntryId: () => `direct-unit-${(sequence += 1)}`, db: context.db, now };
  }

  async function load(workEntryId: string): Promise<Record<string, unknown>> {
    return (
      await context.server.inject({ method: "GET", url: `/api/manual-works/${workEntryId}` })
    ).json();
  }

  it("initializes a manual Work with one section the editor can load", async () => {
    const workEntryId = await createManualWork();

    const response = await context.server.inject({
      method: "GET",
      url: `/api/manual-works/${workEntryId}`
    });

    expect(response.statusCode).toBe(200);
    const dto = response.json();
    expect(dto.entryId).toBe(workEntryId);
    expect(dto.title).toBe("Reading notes");
    expect(dto.language).toBe("en");
    expect(dto.workType).toBe("book");
    expect(typeof dto.revision).toBe("string");
    expect(dto.revision).toBe(dto.updatedAt);
    expect(dto.document.type).toBe("doc");
    expect(dto.document.content).toHaveLength(1);
    expect(dto.document.content[0].type).toBe("paragraph");
    expect(documentText(dto.document)).toBe("");
    // A single-section Work opens at that section and lists exactly it (headingless — no heading yet).
    expect(dto.sections).toHaveLength(1);
    expect(dto.sections[0].unitEntryId).toBe(dto.unitEntryId);
    expect(dto.sections[0].orderIndex).toBe(0);
    expect(dto.sections[0].headingLevel).toBeUndefined();
    expect(dto.sections[0].title).toBeUndefined();
  });

  it("returns 404 for an unknown, imported, or non-manual Work", async () => {
    const importedEntryId = await createImportedWork();

    const unknown = await context.server.inject({
      method: "GET",
      url: "/api/manual-works/work-missing"
    });
    const imported = await context.server.inject({
      method: "GET",
      url: `/api/manual-works/${importedEntryId}`
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });
    expect(imported.statusCode).toBe(404);
  });

  it("does not load another user's manual Work", async () => {
    const workEntryId = await createManualWork();

    const asOwner = await loadManualWorkForEditing(
      context.db,
      toEntryId(workEntryId),
      DEFAULT_USER_ID
    );
    const asStranger = await loadManualWorkForEditing(
      context.db,
      toEntryId(workEntryId),
      "another-user"
    );

    expect(asOwner).toBeDefined();
    expect(asStranger).toBeUndefined();
  });

  it("saves an edit, returns a new revision, and reopens the persisted document", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const document = { content: [paragraph("First line"), paragraph("Second line")], type: "doc" };
    const save = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`,
      payload: { document, revision: loaded.revision }
    });

    expect(save.statusCode).toBe(200);
    const saved = save.json();
    expect(saved.revision).not.toBe(loaded.revision);
    expect(documentText(saved.document)).toBe("First lineSecond line");

    const reopened = await load(workEntryId);
    expect(reopened.revision).toBe(saved.revision);
    expect(documentText(reopened.document as DocumentNodeJSON)).toBe("First lineSecond line");
    expect((reopened.document as { content: unknown[] }).content).toHaveLength(2);
  });

  it("preserves stable block ids across a save so anchored notes stay valid", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const firstBlock = (loaded.document as { content: Array<{ attrs: { id: string } }> })
      .content[0];
    const originalId = firstBlock.attrs.id;
    expect(typeof originalId).toBe("string");

    const document = { content: [firstBlock, paragraph("A new second block")], type: "doc" };
    const save = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`,
      payload: { document, revision: loaded.revision }
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().document.content[0].attrs.id).toBe(originalId);
  });

  it("rejects a stale save with 409 and writes nothing", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);
    const unitUrl = `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`;

    const first = await context.server.inject({
      method: "PUT",
      url: unitUrl,
      payload: {
        document: { content: [paragraph("Winner")], type: "doc" },
        revision: loaded.revision
      }
    });
    expect(first.statusCode).toBe(200);

    const stale = await context.server.inject({
      method: "PUT",
      url: unitUrl,
      payload: {
        document: { content: [paragraph("Loser")], type: "doc" },
        revision: loaded.revision
      }
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "revision_conflict" });

    const reopened = await load(workEntryId);
    expect(documentText(reopened.document as DocumentNodeJSON)).toBe("Winner");
  });

  it("lets only one of two saves that loaded the same revision win", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);
    const unitUrl = `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`;

    const [a, b] = await Promise.all([
      context.server.inject({
        method: "PUT",
        url: unitUrl,
        payload: { document: { content: [paragraph("A")], type: "doc" }, revision: loaded.revision }
      }),
      context.server.inject({
        method: "PUT",
        url: unitUrl,
        payload: { document: { content: [paragraph("B")], type: "doc" }, revision: loaded.revision }
      })
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    const winner = a.statusCode === 200 ? a : b;
    const reopened = await load(workEntryId);
    expect(documentText(reopened.document as DocumentNodeJSON)).toBe(
      documentText(winner.json().document)
    );
    expect(["A", "B"]).toContain(documentText(reopened.document as DocumentNodeJSON));
  });

  it("bumps the revision past a non-advancing clock so a stale save cannot be replayed", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);
    const frozenClock = (): Date => new Date(loaded.revision as string);

    const first = await updateManualWorkContent(
      commandDeps(frozenClock),
      toEntryId(workEntryId),
      toEntryId(loaded.unitEntryId as string),
      { content: [paragraph("Winner")], type: "doc" },
      loaded.revision as string,
      DEFAULT_USER_ID
    );

    expect(first.status).toBe("updated");
    if (first.status !== "updated") {
      throw new Error("expected the first save to land");
    }
    expect(new Date(first.work.revision).getTime()).toBeGreaterThan(
      new Date(loaded.revision as string).getTime()
    );

    const replay = await updateManualWorkContent(
      commandDeps(frozenClock),
      toEntryId(workEntryId),
      toEntryId(loaded.unitEntryId as string),
      { content: [paragraph("Loser")], type: "doc" },
      loaded.revision as string,
      DEFAULT_USER_ID
    );

    expect(replay.status).toBe("conflict");

    const reopened = await load(workEntryId);
    expect(documentText(reopened.document as DocumentNodeJSON)).toBe("Winner");
  });

  it("treats a non-timestamp revision as a conflict rather than crashing", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const response = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`,
      payload: { document: { content: [paragraph("x")], type: "doc" }, revision: "not-a-timestamp" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "revision_conflict" });
  });

  it("returns 404 when saving an unknown or imported Work", async () => {
    const importedEntryId = await createImportedWork();
    const document = { content: [paragraph("x")], type: "doc" };

    const unknown = await context.server.inject({
      method: "PUT",
      url: "/api/manual-works/work-missing/units/unit-x/content",
      payload: { document, revision: "2026-01-01T00:00:00.000Z" }
    });
    const imported = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${importedEntryId}/units/unit-x/content`,
      payload: { document, revision: "2026-01-01T00:00:00.000Z" }
    });

    expect(unknown.statusCode).toBe(404);
    expect(imported.statusCode).toBe(404);
  });

  it("returns 404 when saving a section that is not part of the Work", async () => {
    const workEntryId = await createManualWork();
    const otherWorkId = await createManualWork({ title: "Another" });
    const other = await load(otherWorkId);
    const loaded = await load(workEntryId);

    // A section id that belongs to a DIFFERENT owned manual Work must not be writable through this Work.
    const response = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${other.unitEntryId}/content`,
      payload: { document: { content: [paragraph("x")], type: "doc" }, revision: loaded.revision }
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not save another user's manual Work", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const result = await updateManualWorkContent(
      commandDeps(),
      toEntryId(workEntryId),
      toEntryId(loaded.unitEntryId as string),
      { content: [paragraph("Intruder")], type: "doc" },
      loaded.revision as string,
      "another-user"
    );

    expect(result.status).toBe("not_found");
  });

  it("rejects a malformed save body with 400", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const response = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`,
      payload: { document: { type: "not-a-doc" }, revision: "r" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("appends a heading-led section, opens it, and lists both sections in order", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const added = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: loaded.revision }
    });

    expect(added.statusCode).toBe(201);
    const dto = added.json();
    // The response opens AT the new section: its document is a Heading 1 + a paragraph, and the outline
    // now lists two sections in source order.
    expect(dto.unitEntryId).not.toBe(loaded.unitEntryId);
    expect(dto.document.content[0].type).toBe("heading");
    expect(dto.document.content[0].attrs.level).toBe(1);
    expect(new Date(dto.revision).getTime()).toBeGreaterThan(
      new Date(loaded.revision as string).getTime()
    );
    expect(dto.sections).toHaveLength(2);
    expect(dto.sections[0].unitEntryId).toBe(loaded.unitEntryId);
    expect(dto.sections[1].unitEntryId).toBe(dto.unitEntryId);
    expect(dto.sections[1].orderIndex).toBe(1);
    // The new section starts at an EMPTY heading, so it carries a level but no title until named.
    expect(dto.sections[1].headingLevel).toBe(1);
    expect(dto.sections[1].title).toBeUndefined();
  });

  it("derives each section's outline title from its heading text after saves", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    // Name the first section by saving a Heading 1 into it.
    const savedFirst = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${loaded.unitEntryId}/content`,
      payload: {
        document: { content: [heading(1, "Part One"), paragraph("Body")], type: "doc" },
        revision: loaded.revision
      }
    });
    expect(savedFirst.statusCode).toBe(200);

    // Add a second section and name it.
    const added = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: savedFirst.json().revision }
    });
    expect(added.statusCode).toBe(201);
    const secondUnitId = added.json().unitEntryId as string;

    const savedSecond = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${secondUnitId}/content`,
      payload: {
        document: { content: [heading(2, "Chapter A")], type: "doc" },
        revision: added.json().revision
      }
    });
    expect(savedSecond.statusCode).toBe(200);

    const sections = savedSecond.json().sections as Array<Record<string, unknown>>;
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ headingLevel: 1, title: "Part One" });
    expect(sections[1]).toMatchObject({ headingLevel: 2, title: "Chapter A" });
  });

  it("loads one section's document on demand, owner- and work-scoped", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);
    const added = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: loaded.revision }
    });
    const secondUnitId = added.json().unitEntryId as string;

    const unit = await context.server.inject({
      method: "GET",
      url: `/api/manual-works/${workEntryId}/units/${secondUnitId}`
    });
    expect(unit.statusCode).toBe(200);
    expect(unit.json().unitEntryId).toBe(secondUnitId);
    expect(unit.json().document.content[0].type).toBe("heading");

    // A section id from another Work is a 404 through this Work's path.
    const otherWorkId = await createManualWork({ title: "Another" });
    const other = await load(otherWorkId);
    const crossWork = await context.server.inject({
      method: "GET",
      url: `/api/manual-works/${workEntryId}/units/${other.unitEntryId}`
    });
    expect(crossWork.statusCode).toBe(404);

    // A stranger cannot read the section directly.
    const asStranger = await loadManualWorkUnit(
      context.db,
      toEntryId(workEntryId),
      toEntryId(secondUnitId),
      "another-user"
    );
    expect(asStranger).toBeUndefined();
  });

  it("returns 404 when a section GET targets an unknown or imported Work", async () => {
    const importedEntryId = await createImportedWork();

    const unknown = await context.server.inject({
      method: "GET",
      url: "/api/manual-works/work-missing/units/unit-x"
    });
    const imported = await context.server.inject({
      method: "GET",
      url: `/api/manual-works/${importedEntryId}/units/unit-x`
    });

    expect(unknown.statusCode).toBe(404);
    expect(imported.statusCode).toBe(404);
  });

  it("rejects adding a section on a stale revision with 409 and writes nothing", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const first = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: loaded.revision }
    });
    expect(first.statusCode).toBe(201);

    const stale = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: loaded.revision }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "revision_conflict" });

    // Exactly one section was added (the winner), not two.
    const reopened = await load(workEntryId);
    expect((reopened.sections as unknown[]).length).toBe(2);
  });

  it("returns 404 when adding a section to an unknown or imported Work", async () => {
    const importedEntryId = await createImportedWork();

    const unknown = await context.server.inject({
      method: "POST",
      url: "/api/manual-works/work-missing/units",
      payload: { revision: "2026-01-01T00:00:00.000Z" }
    });
    const imported = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${importedEntryId}/units`,
      payload: { revision: "2026-01-01T00:00:00.000Z" }
    });

    expect(unknown.statusCode).toBe(404);
    expect(imported.statusCode).toBe(404);
  });

  it("does not add a section to another user's manual Work", async () => {
    const workEntryId = await createManualWork();
    const loaded = await load(workEntryId);

    const result = await addManualWorkSection(
      commandDeps(),
      toEntryId(workEntryId),
      loaded.revision as string,
      "another-user"
    );

    expect(result.status).toBe("not_found");
  });

  it("rejects a malformed add-section body with 400", async () => {
    const workEntryId = await createManualWork();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { unexpected: true }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("derives the same heading hierarchy for the Reader as the live Outline (#697 parity)", async () => {
    const workEntryId = await createManualWork();
    const initial = await load(workEntryId);

    // Section A stays headless — a lead paragraph with no heading.
    const savedA = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${initial.unitEntryId}/content`,
      payload: {
        document: { content: [paragraph("A lead paragraph before any heading.")], type: "doc" },
        revision: initial.revision
      }
    });
    expect(savedA.statusCode).toBe(200);

    // Section B: a level-1 "Part One" heading.
    const addedB = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: savedA.json().revision }
    });
    const unitB = addedB.json().unitEntryId as string;
    const savedB = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${unitB}/content`,
      payload: {
        document: { content: [heading(1, "Part One"), paragraph("Body.")], type: "doc" },
        revision: addedB.json().revision
      }
    });
    expect(savedB.statusCode).toBe(200);

    // Section C: a level-2 "Chapter One" heading that nests under Part One.
    const addedC = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: savedB.json().revision }
    });
    const unitC = addedC.json().unitEntryId as string;
    const savedC = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${unitC}/content`,
      payload: {
        document: { content: [heading(2, "Chapter One"), paragraph("Body.")], type: "doc" },
        revision: addedC.json().revision
      }
    });
    expect(savedC.statusCode).toBe(200);

    const structure = await loadWorkStructure(context.db, toEntryId(workEntryId));
    const units = structure.readingUnits;
    expect(units).toHaveLength(3);

    // The Reader structure derives each unit's heading level and title from its first persisted
    // doc_block — the same source the editor's live Outline reads — leaving the headless lead bare.
    const byId = new Map(units.map((unit) => [unit.entryId as string, unit]));
    const lead = byId.get(initial.unitEntryId as string);
    expect(lead?.orderIndex).toBe(0);
    expect(lead?.headingLevel).toBeUndefined();
    expect(lead?.title).toBeUndefined();
    expect(byId.get(unitB)).toMatchObject({ headingLevel: 1, title: "Part One" });
    expect(byId.get(unitC)).toMatchObject({ headingLevel: 2, title: "Chapter One" });

    // The derived table of contents nests Chapter One under Part One, the headless lead as "Start".
    const toc = structure.tableOfContents ?? [];
    expect(toc.map((entry) => ({ depth: entry.depth, label: entry.label }))).toEqual([
      { depth: 0, label: "Start" },
      { depth: 0, label: "Part One" },
      { depth: 1, label: "Chapter One" }
    ]);
  });

  it("merges a non-leading section into the preceding unit when its heading is removed (#698)", async () => {
    const workEntryId = await createManualWork();
    const initial = await load(workEntryId);

    // The leading section stays a legitimate headless "Start".
    const savedLead = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${initial.unitEntryId}/content`,
      payload: {
        document: { content: [paragraph("A lead paragraph before any heading.")], type: "doc" },
        revision: initial.revision
      }
    });
    expect(savedLead.statusCode).toBe(200);

    // A second, heading-led section — two bounded units at this point.
    const added = await context.server.inject({
      method: "POST",
      url: `/api/manual-works/${workEntryId}/units`,
      payload: { revision: savedLead.json().revision }
    });
    const secondUnitId = added.json().unitEntryId as string;
    const savedSecond = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${secondUnitId}/content`,
      payload: {
        document: { content: [heading(1, "Section Two"), paragraph("Body.")], type: "doc" },
        revision: added.json().revision
      }
    });
    expect(savedSecond.statusCode).toBe(200);
    expect(savedSecond.json().sections).toHaveLength(2);

    // Saving the non-leading section with a non-heading first block removes its boundary: under #698 it
    // merges into the preceding "Start" instead of being coerced back into a heading.
    const merged = await context.server.inject({
      method: "PUT",
      url: `/api/manual-works/${workEntryId}/units/${secondUnitId}/content`,
      payload: {
        document: { content: [paragraph("Body only now.")], type: "doc" },
        revision: savedSecond.json().revision
      }
    });
    expect(merged.statusCode).toBe(200);

    // One section remains — the headless lead — and the editor opens at it (the merged-into unit).
    const sections = merged.json().sections as Array<Record<string, unknown>>;
    expect(sections).toHaveLength(1);
    expect(sections[0].headingLevel).toBeUndefined();
    expect(sections[0].title).toBeUndefined();
    expect(sections[0].unitEntryId).toBe(initial.unitEntryId);
    expect(merged.json().unitEntryId).toBe(initial.unitEntryId);
    expect(documentText(merged.json().document)).toBe(
      "A lead paragraph before any heading.Body only now."
    );

    // Reader parity: exactly one unit and one "Start"; the merged-away section id is gone.
    const structure = await loadWorkStructure(context.db, toEntryId(workEntryId));
    expect(structure.readingUnits).toHaveLength(1);
    const byId = new Map(structure.readingUnits.map((unit) => [unit.entryId as string, unit]));
    expect(byId.get(initial.unitEntryId as string)?.headingLevel).toBeUndefined();
    expect(byId.get(secondUnitId)).toBeUndefined();

    // A lone headless unit needs no table of contents (a "Start" label only appears alongside headings).
    expect(structure.tableOfContents ?? []).toEqual([]);
  });
});
