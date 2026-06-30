import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  IngestEpubResultDto,
  NoteDto,
  NoteListDto,
  NotesOverviewListDto,
  ReadingPositionResponse
} from "@whetstone/contracts";
import { epubContentType } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { docBlocks } from "../../db/schema.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import type { ParsedEpub } from "../../files/epubSource.js";
import { createServer } from "../../http/createServer.js";
import { seedNoteTemplates } from "../notes/noteCommands.js";
import type { ContentDependencies } from "./contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";

type TestContext = Readonly<{
  db: DbClient;
  imagesDir: string;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
}>;

// One EPUB chapter so ingestion writes PM `doc_blocks` (a heading + a paragraph) the reader renders;
// the Markdown path writes none, so an EPUB is the substrate that exercises the doc_block anchor path.
function singleChapterEpub(): ParsedEpub {
  return {
    chapters: [{ html: "<h1>Chapter One</h1><p>The quick brown fox.</p>", images: [] }],
    metadata: { author: "Aesop", language: "en", title: "Fables" }
  };
}

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  await seedNoteTemplates(db);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-doc-anchor-"));
  const imagesDir = await mkdtemp(join(tmpdir(), "whetstone-doc-anchor-img-"));

  let workSequence = 0;
  let entrySequence = 0;
  let sourceSequence = 0;
  let authorSequence = 0;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(workSequence += 1)}`,
    createEntryId: () => `work-${workSequence}`,
    db
  };
  const content: ContentDependencies = {
    createAuthorId: () => `epub-author-${(authorSequence += 1)}`,
    createEntryId: () => `entry-${(entrySequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    epubParser: async () => singleChapterEpub(),
    imageResourceStore: createImageResourceStore(imagesDir),
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return {
    db,
    imagesDir,
    server: createServer({
      content,
      library,
      logger: false,
      notes: { createEntryId: () => `note-${(entrySequence += 1)}`, db },
      readingPosition: { db }
    }),
    sourcesDir
  };
}

// Ingest the EPUB and return the new work plus a PM `doc_block` (its stable id, owning unit, and
// plaintext) — the id the reader stamps as `data-block-id` and the user selects within.
async function ingestEpubWithDocBlock(): Promise<{
  docBlockId: string;
  plaintext: string;
  unitEntryId: string;
  workEntryId: string;
}> {
  const response = await context.server.inject({
    headers: { "content-type": epubContentType },
    method: "POST",
    payload: Buffer.from("epub-doc-anchor"),
    url: "/api/works/epub"
  });
  expect(response.statusCode).toBe(201);
  const workEntryId = (response.json() as IngestEpubResultDto).content.workEntryId;

  const rows = await context.db.select().from(docBlocks);
  const row = rows.sort((a, b) => a.orderIndex - b.orderIndex)[0];

  return {
    docBlockId: row?.id as string,
    plaintext: row?.plaintext as string,
    unitEntryId: row?.readingUnitEntryId as string,
    workEntryId
  };
}

function postNote(workEntryId: string, payload: unknown): ReturnType<typeof context.server.inject> {
  return context.server.inject({ method: "POST", payload, url: `/api/works/${workEntryId}/notes` });
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
  await rm(context.imagesDir, { force: true, recursive: true });
});

describe("PM doc_block ids are first-class addressable anchors (#312 regression)", () => {
  it("computes a non-empty plaintext for each persisted PM doc_block", async () => {
    const { plaintext } = await ingestEpubWithDocBlock();

    // The heading block's plaintext is its concatenated descendant text — the search/anchor text the
    // legacy `blocks` row also carries; without it a doc_block could not back a note's context check.
    expect(plaintext).toBe("Chapter One");
  });

  it("creates a note anchored to a PM doc_block id (not block_not_found) and lists/opens it", async () => {
    const { docBlockId, plaintext, workEntryId } = await ingestEpubWithDocBlock();

    const created = await postNote(workEntryId, {
      answers: { noticed: "A tidy opening." },
      anchor: {
        blockEntryId: docBlockId,
        contextSnapshot: plaintext,
        selectedTextSnapshot: plaintext
      },
      templateId: "thought"
    });
    expect(created.statusCode).toBe(201);
    const note = created.json() as NoteDto;
    expect(note.blockEntryId).toBe(docBlockId);

    // The work's note list resolves the doc_block anchor and returns the note with its context.
    const list = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/notes`
    });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as NoteListDto).notes;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.entryId).toBe(note.entryId);
    expect(listed[0]?.anchor.blockEntryId).toBe(docBlockId);
    expect(listed[0]?.anchor.contextSnapshot).toBe(plaintext);

    // The cross-work Notes overview resolves the doc_block anchor too (work title + author).
    const overview = await context.server.inject({ method: "GET", url: "/api/notes" });
    const overviewNotes = (overview.json() as NotesOverviewListDto).notes;
    expect(overviewNotes).toHaveLength(1);
    expect(overviewNotes[0]?.workTitle).toBe("Fables");
    expect(overviewNotes[0]?.workEntryId).toBe(workEntryId);

    // Editing the note authorizes through the doc_block-anchored lookup (getNoteForWork).
    const patched = await context.server.inject({
      method: "PATCH",
      payload: { answers: { noticed: "Revised." }, templateId: "thought" },
      url: `/api/works/${workEntryId}/notes/${note.entryId}`
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as NoteDto).answers["noticed"]).toBe("Revised.");
  });

  it("saves and restores a reading position anchored to a PM doc_block id", async () => {
    const { docBlockId, unitEntryId, workEntryId } = await ingestEpubWithDocBlock();

    const put = await context.server.inject({
      method: "PUT",
      payload: { anchorBlockEntryId: docBlockId, unitEntryId },
      url: `/api/works/${workEntryId}/reading-position`
    });
    expect(put.statusCode).toBe(204);

    const get = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/reading-position`
    });
    expect((get.json() as ReadingPositionResponse).position).toEqual({
      anchorBlockEntryId: docBlockId,
      unitEntryId
    });
  });

  it("locates a PM doc_block id to its owning reading unit (jump / scroll-to-block)", async () => {
    const { docBlockId, unitEntryId, workEntryId } = await ingestEpubWithDocBlock();

    const located = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/blocks/${docBlockId}/unit`
    });
    expect(located.statusCode).toBe(200);
    expect(located.json()).toEqual({ unitEntryId });
  });
});
