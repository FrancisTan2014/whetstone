import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ImportNotesResultDto,
  NoteDto,
  NoteListDto,
  NotesOverviewListDto,
  ReadingUnitContentDto,
  WorkContentDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { fingerprintNoteMaterial } from "./noteMaterialFingerprint.js";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  entries,
  entryLinks,
  memoryPrompts,
  noteAnchors,
  notes,
  personalEntries,
  reviewCards
} from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { NotesDependencies } from "./noteCommands.js";
import { listNotesForUser, listNotesForWork } from "./noteQueries.js";
import { newReviewState, RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { reviewStateColumns } from "../review/reviewCardQueries.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import { createWork as createWorkCommand } from "../library/libraryCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";

type TestContext = Readonly<{
  db: DbClient;
  library: LibraryDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
  sourcesDir: string;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-notes-"));

  let workSequence = 0;
  let contentSequence = 0;
  let noteSequence = 0;
  let sourceSequence = 0;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(workSequence += 1)}`,
    createEntryId: () => `work-${workSequence}`,
    db,
    now: () => new Date()
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(contentSequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  // A fixed clock a test can pin so it can assert the shared `personal_entries` chronology timestamps;
  // unset it defaults to the real clock, preserving the timing of tests that don't care.
  let currentNow: Date | null = null;
  const notesDeps: NotesDependencies = {
    createEntryId: () => `note-${(noteSequence += 1)}`,
    db,
    now: () => currentNow ?? new Date()
  };

  return {
    db,
    library,
    server: createServer({ content, library, logger: false, notes: notesDeps }),
    setNow: (iso: string) => {
      currentNow = new Date(iso);
    },
    sourcesDir
  };
}

// Seeds an imported Work shell through the `createWork` command — the legacy `POST /api/works` route is
// retired (#750), so notes fixtures mint their backing Work the same way an ingest path commits one.
async function seedImportedWork(
  title: string,
  authorName: string,
  workType: "book" | "classical_text"
): Promise<string> {
  const created = await createWorkCommand(
    context.library,
    {
      author: { mode: "new", name: authorName },
      language: "en",
      origin: "imported",
      title,
      workType
    },
    DEFAULT_USER_ID
  );
  if (created.status !== "created") {
    throw new Error("expected the imported seed Work to be created");
  }
  return created.work.work.entryId;
}

async function createWorkWithBlock(): Promise<{
  blockEntryId: string;
  plaintext: string;
  workEntryId: string;
}> {
  const workEntryId = await seedImportedWork("Fables", "Aesop", "classical_text");

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox jumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const body = await listContent(workEntryId);
  const block = body.readingUnits[0]?.blocks[0];

  return {
    blockEntryId: block?.entryId as string,
    plaintext: block?.plaintext as string,
    workEntryId
  };
}

// A work titled/authored as given, with one manual markdown block — for cross-work tests where the
// distinct titles drive the Notes overview ordering.
async function createWorkTitled(
  title: string,
  author: string
): Promise<{ blockEntryId: string; plaintext: string; workEntryId: string }> {
  const workEntryId = await seedImportedWork(title, author, "book");

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: `Body for ${title}.` },
    url: `/api/works/${workEntryId}/content`
  });

  const body = await listContent(workEntryId);
  const block = body.readingUnits[0]?.blocks[0];

  return {
    blockEntryId: block?.entryId as string,
    plaintext: block?.plaintext as string,
    workEntryId
  };
}

// A work whose single reading unit holds two paragraph blocks, for cross-block span notes (#257).
async function createWorkWithTwoBlocks(): Promise<{
  endBlockEntryId: string;
  endPlaintext: string;
  startBlockEntryId: string;
  startPlaintext: string;
  workEntryId: string;
}> {
  const workEntryId = await seedImportedWork("Two Paragraphs", "Aesop", "classical_text");

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox.\n\nJumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const body = await listContent(workEntryId);
  const blocks = body.readingUnits[0]?.blocks ?? [];

  return {
    endBlockEntryId: blocks[1]?.entryId as string,
    endPlaintext: blocks[1]?.plaintext as string,
    startBlockEntryId: blocks[0]?.entryId as string,
    startPlaintext: blocks[0]?.plaintext as string,
    workEntryId
  };
}

// A work with two reading units (a leading paragraph, then a heading + paragraph), for asserting a
// span across reading units is rejected (#257).
async function createWorkWithTwoUnits(): Promise<{
  firstUnitBlockEntryId: string;
  firstUnitPlaintext: string;
  secondUnitBlockEntryId: string;
  workEntryId: string;
}> {
  const workEntryId = await seedImportedWork("Two Units", "Aesop", "classical_text");

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox.\n\n# Heading\n\nJumps over." },
    url: `/api/works/${workEntryId}/content`
  });

  const body = await listContent(workEntryId);

  return {
    firstUnitBlockEntryId: body.readingUnits[0]?.blocks[0]?.entryId as string,
    firstUnitPlaintext: body.readingUnits[0]?.blocks[0]?.plaintext as string,
    secondUnitBlockEntryId: body.readingUnits[1]?.blocks[0]?.entryId as string,
    workEntryId
  };
}

function postNote(workEntryId: string, payload: unknown): ReturnType<typeof context.server.inject> {
  return context.server.inject({ method: "POST", payload, url: `/api/works/${workEntryId}/notes` });
}

async function createSubBlockNote(
  workEntryId: string,
  blockEntryId: string,
  plaintext: string
): Promise<NoteDto> {
  const response = await postNote(workEntryId, {
    anchor: {
      blockEntryId,
      contextSnapshot: plaintext,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    },
    bodyDoc: createTextDocument("to outwit")
  });

  return response.json() as NoteDto;
}

async function createWholeBlockNote(
  workEntryId: string,
  blockEntryId: string,
  plaintext: string
): Promise<NoteDto> {
  const response = await postNote(workEntryId, {
    anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
    bodyDoc: createTextDocument("A tidy aphorism.")
  });

  return response.json() as NoteDto;
}

function listNotes(workEntryId: string): ReturnType<typeof context.server.inject> {
  return context.server.inject({ method: "GET", url: `/api/works/${workEntryId}/notes` });
}

async function listContent(workEntryId: string): Promise<WorkContentDto> {
  const structureResponse = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/structure`
  });
  const structure = structureResponse.json() as WorkStructureDto;

  const readingUnits = await Promise.all(
    structure.readingUnits.map(async (meta) => {
      const unitResponse = await context.server.inject({
        method: "GET",
        url: `/api/works/${workEntryId}/units/${meta.entryId}/content`
      });

      return unitResponse.json() as ReadingUnitContentDto;
    })
  );

  return { readingUnits, workEntryId: structure.workEntryId };
}

function patchNote(
  workEntryId: string,
  noteEntryId: string,
  payload: unknown
): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "PATCH",
    payload,
    url: `/api/works/${workEntryId}/notes/${noteEntryId}`
  });
}

function deleteNoteRequest(
  workEntryId: string,
  noteEntryId: string
): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "DELETE",
    url: `/api/works/${workEntryId}/notes/${noteEntryId}`
  });
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
});

describe("create note route", () => {
  it("creates a sub-block note linked to its source block, deriving its readable text", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      },
      bodyDoc: createTextDocument("to surrender")
    });

    expect(response.statusCode).toBe(201);
    const note = response.json() as NoteDto;
    expect(note.kind).toBe("note");
    expect(note.blockEntryId).toBe(blockEntryId);
    expect(note.bodyDoc).toEqual(createTextDocument("to surrender"));
    // The readable text is derived on the server, never trusted from the client.
    expect(note.bodyText).toBe("to surrender");
    expect(note.anchor).toEqual({
      blockEntryId,
      contextSnapshot: plaintext,
      endBlockEntryId: blockEntryId,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });

    const noteRows = await context.db.select().from(notes).where(eq(notes.entryId, note.entryId));
    expect(noteRows[0]?.kind).toBe("note");
    expect(noteRows[0]?.bodyDoc).toEqual(createTextDocument("to surrender"));
    expect(noteRows[0]?.bodyText).toBe("to surrender");
    expect(noteRows[0]?.captureSource).toBe("reader");

    const anchorRows = await context.db
      .select()
      .from(noteAnchors)
      .where(eq(noteAnchors.noteEntryId, note.entryId));
    expect(anchorRows[0]?.blockEntryId).toBe(blockEntryId);
    expect(anchorRows[0]?.endBlockEntryId).toBe(blockEntryId);
    expect(anchorRows[0]?.startOffset).toBe(10);

    const links = await context.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.fromEntryId, note.entryId));
    expect(links).toEqual([
      { fromEntryId: note.entryId, toEntryId: blockEntryId, type: "annotates" }
    ]);
  });

  it("creates a whole-block note without an offset range", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      bodyDoc: createTextDocument("A tidy aphorism.")
    });

    expect(response.statusCode).toBe(201);
    const note = response.json() as NoteDto;
    expect(note.anchor.startOffset).toBeUndefined();

    const anchorRows = await context.db
      .select()
      .from(noteAnchors)
      .where(eq(noteAnchors.noteEntryId, note.entryId));
    expect(anchorRows[0]?.startOffset).toBeNull();
  });

  it("rejects a blank note body at the boundary", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      bodyDoc: createTextDocument("   ")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("returns 404 when the block is not part of the work", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: "missing-block",
        contextSnapshot: "absent text",
        selectedTextSnapshot: "absent"
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "block_not_found" });
  });

  it("rejects a sub-block range that does not index the selected text", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 9,
        selectedTextSnapshot: "brown fox",
        startOffset: 0
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a forged context snapshot absent from the block text", async () => {
    const { blockEntryId, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: "a sly brown fox from another tale",
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a whole-block selection absent from the block text", async () => {
    const { blockEntryId, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: "absent here",
        selectedTextSnapshot: "absent"
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a malformed request body at the boundary", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, { bodyDoc: createTextDocument("x") });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("persists and serves a cross-block span note (#257)", async () => {
    const { endBlockEntryId, endPlaintext, startBlockEntryId, startPlaintext, workEntryId } =
      await createWorkWithTwoBlocks();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: startBlockEntryId,
        contextSnapshot: startPlaintext,
        endBlockEntryId,
        endOffset: 5,
        selectedTextSnapshot: "fox. Jumps",
        startOffset: 16
      },
      bodyDoc: createTextDocument("spanning two blocks")
    });

    expect(response.statusCode).toBe(201);
    const note = response.json() as NoteDto;
    expect(note.anchor.blockEntryId).toBe(startBlockEntryId);
    expect(note.anchor.endBlockEntryId).toBe(endBlockEntryId);
    expect(note.anchor.startOffset).toBe(16);
    expect(note.anchor.endOffset).toBe(5);

    // Round-trips through the list with both block ids intact.
    const listed = (await listNotes(workEntryId)).json() as NoteListDto;
    const served = listed.notes.find((item) => item.entryId === note.entryId);
    expect(served?.anchor.endBlockEntryId).toBe(endBlockEntryId);
    // A sanity check on the fixtures: the offsets sit within their own blocks.
    expect(startPlaintext.length).toBeGreaterThanOrEqual(16);
    expect(endPlaintext.length).toBeGreaterThanOrEqual(5);
  });

  it("returns 404 when a cross-block span's end block is not in the work (#257)", async () => {
    const { startBlockEntryId, startPlaintext, workEntryId } = await createWorkWithTwoBlocks();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: startBlockEntryId,
        contextSnapshot: startPlaintext,
        endBlockEntryId: "not-in-this-work",
        endOffset: 5,
        selectedTextSnapshot: "fox",
        startOffset: 16
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "block_not_found" });
  });

  it("rejects a cross-block span whose offset runs past its block (#257)", async () => {
    const { endBlockEntryId, startBlockEntryId, startPlaintext, workEntryId } =
      await createWorkWithTwoBlocks();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: startBlockEntryId,
        contextSnapshot: startPlaintext,
        endBlockEntryId,
        endOffset: 9999,
        selectedTextSnapshot: "fox",
        startOffset: 16
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a cross-block span whose end block precedes its start block in one unit (#257)", async () => {
    const { endBlockEntryId, endPlaintext, startBlockEntryId, workEntryId } =
      await createWorkWithTwoBlocks();

    // Reversed: the start is the later block and the end is the earlier block, same unit.
    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: endBlockEntryId,
        contextSnapshot: endPlaintext,
        endBlockEntryId: startBlockEntryId,
        endOffset: 5,
        selectedTextSnapshot: "reversed",
        startOffset: 5
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a span whose blocks are in different reading units (#257)", async () => {
    const { firstUnitBlockEntryId, firstUnitPlaintext, secondUnitBlockEntryId, workEntryId } =
      await createWorkWithTwoUnits();

    const response = await postNote(workEntryId, {
      anchor: {
        blockEntryId: firstUnitBlockEntryId,
        contextSnapshot: firstUnitPlaintext,
        endBlockEntryId: secondUnitBlockEntryId,
        endOffset: 4,
        selectedTextSnapshot: "across units",
        startOffset: 4
      },
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });
});

describe("create mark route", () => {
  function postMark(
    workEntryId: string,
    payload: unknown
  ): ReturnType<typeof context.server.inject> {
    return context.server.inject({
      method: "POST",
      payload,
      url: `/api/works/${workEntryId}/marks`
    });
  }

  it("saves a bodyless mark with a null body and lists and deletes like a note", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postMark(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      }
    });

    expect(response.statusCode).toBe(201);
    const mark = response.json() as NoteDto;
    expect(mark.kind).toBe("mark");
    expect(mark.bodyDoc).toBeNull();
    expect(mark.bodyText).toBeNull();
    expect(mark.anchor.selectedTextSnapshot).toBe("brown fox");

    const markRows = await context.db.select().from(notes).where(eq(notes.entryId, mark.entryId));
    expect(markRows[0]?.kind).toBe("mark");
    expect(markRows[0]?.bodyDoc).toBeNull();
    expect(markRows[0]?.bodyText).toBeNull();
    expect(markRows[0]?.captureSource).toBe("reader");

    // It persists and is listed like any note, and can be deleted.
    const listed = (await listNotes(workEntryId)).json() as NoteListDto;
    expect(listed.notes.map((note) => note.entryId)).toEqual([mark.entryId]);

    const deleted = await context.server.inject({
      method: "DELETE",
      url: `/api/works/${workEntryId}/notes/${mark.entryId}`
    });
    expect(deleted.statusCode).toBe(204);
    expect(((await listNotes(workEntryId)).json() as NoteListDto).notes).toEqual([]);
  });

  it("rejects a PATCH that would edit a bodyless mark instead of hitting the DB CHECK", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const created = await postMark(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      }
    });
    const mark = created.json() as NoteDto;

    const response = await patchNote(workEntryId, mark.entryId, {
      bodyDoc: createTextDocument("trying to give a mark a body")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "note_not_editable" });

    // The row stays a bodyless mark: the controlled rejection never wrote body columns.
    const rows = await context.db.select().from(notes).where(eq(notes.entryId, mark.entryId));
    expect(rows[0]?.kind).toBe("mark");
    expect(rows[0]?.bodyDoc).toBeNull();
    expect(rows[0]?.bodyText).toBeNull();
  });

  it("returns 404 when the marked block does not belong to the work", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postMark(workEntryId, {
      anchor: {
        blockEntryId: "block-not-here",
        contextSnapshot: "text",
        selectedTextSnapshot: "text"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "block_not_found" });
  });

  it("rejects a mark whose anchor does not fit the block", async () => {
    const { blockEntryId, workEntryId } = await createWorkWithBlock();

    const response = await postMark(workEntryId, {
      anchor: {
        blockEntryId,
        contextSnapshot: "absent here",
        selectedTextSnapshot: "absent"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a malformed mark body at the boundary", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postMark(workEntryId, { bodyDoc: createTextDocument("x") });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("list notes route", () => {
  it("returns an empty list for a work with no notes", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await listNotes(workEntryId);

    expect(response.statusCode).toBe(200);
    expect((response.json() as NoteListDto).notes).toEqual([]);
  });

  it("returns whole-block and sub-block notes anchored to the work's blocks", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const subBlock = await createSubBlockNote(workEntryId, blockEntryId, plaintext);
    const wholeBlock = await createWholeBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await listNotes(workEntryId);
    const body = response.json() as NoteListDto;

    expect(body.notes.map((note) => note.entryId).sort()).toEqual(
      [subBlock.entryId, wholeBlock.entryId].sort()
    );

    const sub = body.notes.find((note) => note.entryId === subBlock.entryId);
    expect(sub?.anchor).toEqual({
      blockEntryId,
      contextSnapshot: plaintext,
      endBlockEntryId: blockEntryId,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });
    expect(sub?.bodyText).toBe("to outwit");

    const whole = body.notes.find((note) => note.entryId === wholeBlock.entryId);
    expect(whole?.anchor.startOffset).toBeUndefined();
    expect(whole?.anchor.endOffset).toBeUndefined();
    expect(whole?.kind).toBe("note");
  });

  it("does not list a note that belongs to another work", async () => {
    const first = await createWorkWithBlock();
    const note = await createSubBlockNote(first.workEntryId, first.blockEntryId, first.plaintext);
    const second = await createWorkWithBlock();

    const response = await listNotes(second.workEntryId);

    expect((response.json() as NoteListDto).notes).toEqual([]);
    expect(note.entryId).toBeDefined();
  });
});

describe("note user ownership", () => {
  it("stamps a created note with the current user (the v0 default identity)", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const rows = await context.db
      .select({ userId: personalEntries.userId })
      .from(personalEntries)
      .where(eq(personalEntries.entryId, note.entryId));

    expect(rows[0]?.userId).toBe(DEFAULT_USER_ID);
  });

  it("filters note reads by the current user — another user sees none", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    await createSubBlockNote(workEntryId, blockEntryId, plaintext);
    const work = toEntryId(workEntryId);

    const ownerNotes = await listNotesForWork(context.db, work, DEFAULT_USER_ID);
    const otherUserNotes = await listNotesForWork(context.db, work, "another-user");

    expect(ownerNotes).toHaveLength(1);
    expect(otherUserNotes).toEqual([]);
  });
});

describe("update note route", () => {
  it("replaces the note body and re-derives its readable text", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {
      bodyDoc: createTextDocument("Now a thought.")
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as NoteDto;
    expect(updated.kind).toBe("note");
    expect(updated.bodyDoc).toEqual(createTextDocument("Now a thought."));
    expect(updated.bodyText).toBe("Now a thought.");
    expect(updated.anchor).toEqual(note.anchor);

    const rows = await context.db.select().from(notes).where(eq(notes.entryId, note.entryId));
    expect(rows[0]?.bodyDoc).toEqual(createTextDocument("Now a thought."));
    expect(rows[0]?.bodyText).toBe("Now a thought.");

    const listed = (await listNotes(workEntryId).then((r) => r.json())) as NoteListDto;
    expect(listed.notes[0]?.bodyText).toBe("Now a thought.");
  });

  it("bumps the shared personal-entry updated_at on edit, leaving created/occurred at capture (#571)", async () => {
    context.setNow("2026-06-01T00:00:00.000Z");
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const [before] = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, note.entryId));
    expect(before?.updatedAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");

    context.setNow("2026-06-02T09:30:00.000Z");
    const response = await patchNote(workEntryId, note.entryId, {
      bodyDoc: createTextDocument("Edited note.")
    });
    expect(response.statusCode).toBe(200);

    const [after] = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, note.entryId));
    // The edit touches the shared chronology facet's updated_at; created/occurred stay at capture time.
    expect(after?.updatedAt.toISOString()).toBe("2026-06-02T09:30:00.000Z");
    expect(after?.createdAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(after?.occurredAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns 404 when the note does not belong to the work", async () => {
    const first = await createWorkWithBlock();
    const note = await createSubBlockNote(first.workEntryId, first.blockEntryId, first.plaintext);
    const second = await createWorkWithBlock();

    const response = await patchNote(second.workEntryId, note.entryId, {
      bodyDoc: createTextDocument("x")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "note_not_found" });
  });

  it("rejects a blank note body at the boundary", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {
      bodyDoc: createTextDocument("  ")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a malformed update body at the boundary", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {});

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("delete note route", () => {
  it("deletes the note, its anchor, its link, and its entry", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await deleteNoteRequest(workEntryId, note.entryId);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    expect(await context.db.select().from(notes).where(eq(notes.entryId, note.entryId))).toEqual(
      []
    );
    expect(
      await context.db.select().from(noteAnchors).where(eq(noteAnchors.noteEntryId, note.entryId))
    ).toEqual([]);
    expect(
      await context.db.select().from(entryLinks).where(eq(entryLinks.fromEntryId, note.entryId))
    ).toEqual([]);
    expect(await context.db.select().from(entries).where(eq(entries.id, note.entryId))).toEqual([]);

    const listed = (await listNotes(workEntryId).then((r) => r.json())) as NoteListDto;
    expect(listed.notes).toEqual([]);
  });

  it("returns 404 when the note does not belong to the work", async () => {
    const first = await createWorkWithBlock();
    const note = await createSubBlockNote(first.workEntryId, first.blockEntryId, first.plaintext);
    const second = await createWorkWithBlock();

    const response = await deleteNoteRequest(second.workEntryId, note.entryId);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "note_not_found" });

    expect(
      await context.db.select().from(notes).where(eq(notes.entryId, note.entryId))
    ).toHaveLength(1);
  });
});

describe("notes anchored to soft-deleted blocks (re-ingestion)", () => {
  function reingest(
    workEntryId: string,
    markdown: string
  ): ReturnType<typeof context.server.inject> {
    return context.server.inject({
      method: "POST",
      payload: { kind: "manual", markdown },
      url: `/api/works/${workEntryId}/content`
    });
  }

  it("keeps a note listed, editable, and deletable after re-ingestion removes its block", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createWholeBlockNote(workEntryId, blockEntryId, plaintext);

    // Re-ingest unrelated content so the anchored block is removed (soft-deleted).
    await reingest(workEntryId, "An entirely unrelated closing statement.");

    // The reader excludes the removed block.
    const content = (await listContent(workEntryId)) as WorkContentDto;
    expect(
      content.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.entryId))
    ).not.toContain(blockEntryId);

    // The note is still returned for the work.
    const listed = (await listNotes(workEntryId).then((response) =>
      response.json()
    )) as NoteListDto;
    expect(listed.notes.map((each) => each.entryId)).toContain(note.entryId);

    // The note is still editable.
    const patched = await patchNote(workEntryId, note.entryId, {
      bodyDoc: createTextDocument("Still addressable.")
    });
    expect(patched.statusCode).toBe(200);

    // The note is still deletable.
    const deleted = await deleteNoteRequest(workEntryId, note.entryId);
    expect(deleted.statusCode).toBe(204);
    const afterDelete = (await listNotes(workEntryId).then((response) =>
      response.json()
    )) as NoteListDto;
    expect(afterDelete.notes).toEqual([]);
  });
});

describe("cross-work notes overview", () => {
  it("lists every note the user owns across works once each, in recency order (updated_at desc, id tiebreak)", async () => {
    const aesop = await createWorkTitled("Aesop Fables", "Aesop");
    const zen = await createWorkTitled("Zen Mind", "Shunryū Suzuki");
    // The Zen note is created first (note-1) but oldest; the two Aesop notes (note-2, note-3) share the
    // newest instant, so recency order puts them first and the note-id tiebreak keeps note-2 before note-3.
    context.setNow("2026-03-01T00:00:00.000Z");
    await createWholeBlockNote(zen.workEntryId, zen.blockEntryId, zen.plaintext);
    context.setNow("2026-03-02T00:00:00.000Z");
    await createWholeBlockNote(aesop.workEntryId, aesop.blockEntryId, aesop.plaintext);
    await createWholeBlockNote(aesop.workEntryId, aesop.blockEntryId, aesop.plaintext);

    const response = await context.server.inject({ method: "GET", url: "/api/notes" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NotesOverviewListDto;
    expect(body.notes.map((note) => note.entryId)).toEqual(["note-2", "note-3", "note-1"]);
    expect(new Set(body.notes.map((note) => note.entryId)).size).toBe(3);
    expect(body.notes.map((note) => note.workTitle)).toEqual([
      "Aesop Fables",
      "Aesop Fables",
      "Zen Mind"
    ]);

    const first = body.notes[0];
    expect(first?.workEntryId).toBe(aesop.workEntryId);
    expect(first?.authorName).toBe("Aesop");
    expect(first?.blockEntryId).toBe(aesop.blockEntryId);
    expect((first?.bodyText ?? "").length).toBeGreaterThan(0);
    // Every note carries its rolled-up Review projection; an un-enrolled note reads not_enrolled.
    expect(first?.review).toEqual({ status: "not_enrolled" });
  });

  it("lists an unanchored note (a manual/Memory note) with null anchor and work context", async () => {
    // A manual or Memory note is a unified `note` with no source anchor. It is still owned and listed on
    // the cross-work overview, but with null anchor/block and null work fields — the client shows its body
    // only. Routes only create anchored reader notes, so seed the unanchored note directly.
    await context.db.insert(entries).values({ id: "loose-note", type: "note" });
    await context.db.insert(personalEntries).values({
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      entryId: "loose-note",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      userId: DEFAULT_USER_ID
    });
    await context.db.insert(notes).values({
      bodyDoc: createTextDocument("a loose thought"),
      bodyText: "a loose thought",
      captureSource: "manual",
      entryId: "loose-note",
      kind: "note",
      materialFingerprint: fingerprintNoteMaterial(createTextDocument("a loose thought"))
    });

    const response = await context.server.inject({ method: "GET", url: "/api/notes" });

    expect(response.statusCode).toBe(200);
    const note = (response.json() as NotesOverviewListDto).notes.find(
      (candidate) => candidate.entryId === "loose-note"
    );
    expect(note).toBeDefined();
    expect(note?.anchor).toBeNull();
    expect(note?.blockEntryId).toBeNull();
    expect(note?.workEntryId).toBeNull();
    expect(note?.workTitle).toBeNull();
    expect(note?.authorName).toBeNull();
    expect(note?.captureSource).toBe("manual");
    expect(note?.bodyText).toBe("a loose thought");
  });

  it("returns an empty list when the user has no notes", async () => {
    await createWorkTitled("Aesop Fables", "Aesop");

    const response = await context.server.inject({ method: "GET", url: "/api/notes" });

    expect(response.statusCode).toBe(200);
    expect((response.json() as NotesOverviewListDto).notes).toEqual([]);
  });

  it("scopes the overview to the current user", async () => {
    const aesop = await createWorkTitled("Aesop Fables", "Aesop");
    await createWholeBlockNote(aesop.workEntryId, aesop.blockEntryId, aesop.plaintext);

    expect(await listNotesForUser(context.db, DEFAULT_USER_ID, new Date())).toHaveLength(1);
    expect(await listNotesForUser(context.db, "another-user", new Date())).toEqual([]);
  });
});

describe("notes route isolation (cross-user) and failure paths", () => {
  function otherUserServer(): ReturnType<typeof createServer> {
    // A second server over the SAME database but authenticated as a different user, mirroring the
    // route-level isolation test in readingPosition.test.ts.
    return createServer({
      currentUser: { getCurrentUserId: () => "other-user" },
      logger: false,
      notes: { createEntryId: () => "other-note", db: context.db, now: () => new Date() }
    });
  }

  it("does not leak one user's notes to another over the route", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    await createWholeBlockNote(workEntryId, blockEntryId, plaintext);

    const other = otherUserServer();

    try {
      const response = await other.inject({
        method: "GET",
        url: `/api/works/${workEntryId}/notes`
      });

      expect(response.statusCode).toBe(200);
      // Removing `eq(personalEntries.userId, userId)` from listNotesForWork would leak the owner's note here.
      expect((response.json() as NoteListDto).notes).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it("rejects editing or deleting another user's note over the route", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createWholeBlockNote(workEntryId, blockEntryId, plaintext);

    const other = otherUserServer();

    try {
      const patch = await other.inject({
        method: "PATCH",
        payload: { bodyDoc: createTextDocument("hijacked") },
        url: `/api/works/${workEntryId}/notes/${note.entryId}`
      });
      expect(patch.statusCode).toBe(404);

      const remove = await other.inject({
        method: "DELETE",
        url: `/api/works/${workEntryId}/notes/${note.entryId}`
      });
      expect(remove.statusCode).toBe(404);

      // The note is untouched: its owner still sees it.
      const owner = (await listNotes(workEntryId).then((response) =>
        response.json()
      )) as NoteListDto;
      expect(owner.notes.map((each) => each.entryId)).toContain(note.entryId);
    } finally {
      await other.close();
    }
  });

  it("surfaces a 5xx when the database rejects a notes read", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const db = createDbClient(pglite);
    const server = createServer({
      logger: false,
      notes: { createEntryId: () => "x", db, now: () => new Date() }
    });
    await pglite.close();

    try {
      const response = await server.inject({ method: "GET", url: "/api/works/any-work/notes" });

      // A db failure must surface as a server error, not a hang or a false 2xx.
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await server.close();
    }
  });
});

describe("offline-gloss suggestion relocated to Notes (#662)", () => {
  it("rejects a blank term with a 400 and never blocks capture", async () => {
    // A blank or whitespace-only term is a client error, not a null suggestion.
    for (const term of ["", "   "]) {
      const response = await context.server.inject({
        method: "GET",
        query: { term },
        url: "/api/notes/suggest"
      });
      expect(response.statusCode).toBe(400);
    }

    // A missing term param is equally rejected.
    const missing = await context.server.inject({ method: "GET", url: "/api/notes/suggest" });
    expect(missing.statusCode).toBe(400);
  });

  it("returns a null suggestion when no offline dictionary is wired", async () => {
    // The default harness wires no `resolveOfflineGloss`, so a known term still resolves to null —
    // suggestion is optional enrichment, never a hard dependency.
    const response = await context.server.inject({
      method: "GET",
      query: { term: "kanmusu" },
      url: "/api/notes/suggest"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ suggestion: null, term: "kanmusu" });
  });

  it("returns the bundled-dictionary gloss when a glosser is wired", async () => {
    // Wire a glosser and confirm the handler awaits it and returns its result verbatim.
    const server = createServer({
      logger: false,
      notes: {
        createEntryId: () => "note-suggest",
        db: context.db,
        now: () => new Date(),
        resolveOfflineGloss: (text: string) =>
          Promise.resolve(text === "kanmusu" ? "ship girl" : null)
      }
    });

    try {
      const hit = await server.inject({
        method: "GET",
        query: { term: "kanmusu" },
        url: "/api/notes/suggest"
      });
      expect(hit.statusCode).toBe(200);
      expect(hit.json()).toEqual({ suggestion: "ship girl", term: "kanmusu" });

      const miss = await server.inject({
        method: "GET",
        query: { term: "unknown" },
        url: "/api/notes/suggest"
      });
      expect(miss.statusCode).toBe(200);
      expect(miss.json()).toEqual({ suggestion: null, term: "unknown" });
    } finally {
      await server.close();
    }
  });
});

describe("notes home — owner-scoped create, read, edit, delete, filter, and search (#659)", () => {
  let seedSequence = 0;

  function createStandalone(text: string): ReturnType<typeof context.server.inject> {
    return context.server.inject({
      method: "POST",
      payload: { bodyDoc: createTextDocument(text) },
      url: "/api/notes"
    });
  }

  function ownerGet(noteEntryId: string): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "GET", url: `/api/notes/${noteEntryId}` });
  }

  function ownerList(query = ""): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "GET", url: `/api/notes${query}` });
  }

  function ownerPatch(
    noteEntryId: string,
    payload: unknown
  ): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "PATCH", payload, url: `/api/notes/${noteEntryId}` });
  }

  function ownerDelete(noteEntryId: string): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "DELETE", url: `/api/notes/${noteEntryId}` });
  }

  // A second server over the SAME database authenticated as a different user, to prove the owner-scoped
  // routes never read or mutate another learner's note.
  function intruderServer(): ReturnType<typeof createServer> {
    return createServer({
      currentUser: { getCurrentUserId: () => "intruder" },
      logger: false,
      notes: { createEntryId: () => "intruder-note", db: context.db, now: () => new Date() }
    });
  }

  async function createMark(
    workEntryId: string,
    blockEntryId: string,
    plaintext: string
  ): Promise<NoteDto> {
    const response = await context.server.inject({
      method: "POST",
      payload: {
        anchor: {
          blockEntryId,
          contextSnapshot: plaintext,
          endOffset: 19,
          selectedTextSnapshot: "brown fox",
          startOffset: 10
        }
      },
      url: `/api/works/${workEntryId}/marks`
    });
    return response.json() as NoteDto;
  }

  // Seed a Memory prompt (and optionally its review card) directly onto a note so search and the
  // review-summary roll-up can be exercised without the (separately tested) enrollment route. A
  // `current_note` prompt is answerless; a `legacy_custom` prompt carries a preserved custom answer.
  async function seedPrompt(
    noteEntryId: string,
    options: Readonly<{
      answerText?: string;
      card?: Readonly<{ dueAt: Date; status?: "active" | "paused" }>;
      cueText: string;
      revealKind?: "current_note" | "expected_response" | "legacy_custom";
    }>
  ): Promise<void> {
    const revealKind = options.revealKind ?? "current_note";
    const hasAnswer = revealKind === "legacy_custom" || revealKind === "expected_response";
    const promptId = `prompt-seed-${(seedSequence += 1)}`;
    await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await context.db.insert(memoryPrompts).values({
      answerDoc: hasAnswer ? createTextDocument(options.answerText ?? "") : null,
      answerText: hasAnswer ? (options.answerText ?? "") : null,
      cueDoc: createTextDocument(options.cueText),
      cueText: options.cueText,
      entryId: promptId,
      lifecycle: "ready",
      noteEntryId,
      revealKind
    });
    if (options.card !== undefined) {
      const { dueAt } = options.card;
      await context.db.insert(reviewCards).values({
        ...reviewStateColumns(newReviewState(dueAt)),
        createdAt: dueAt,
        dueAt,
        requestedRetention: RECALL_REQUEST_RETENTION,
        status: options.card.status ?? "active",
        targetEntryId: promptId,
        updatedAt: dueAt,
        userId: DEFAULT_USER_ID
      });
    }
  }

  it("creates a standalone note stamped manual, with no anchor, prompt, or card", async () => {
    context.setNow("2026-02-01T00:00:00.000Z");

    const response = await createStandalone("A free-standing thought.");

    expect(response.statusCode).toBe(201);
    const note = response.json() as NoteDto;
    expect(note.kind).toBe("note");
    expect(note.captureSource).toBe("manual");
    expect(note.anchor).toBeNull();
    expect(note.blockEntryId).toBeNull();
    expect(note.bodyText).toBe("A free-standing thought.");
    expect(note.createdAt).toBe("2026-02-01T00:00:00.000Z");

    // The write persists exactly one note aggregate — no anchor and no Memory prompt.
    const anchorRows = await context.db
      .select()
      .from(noteAnchors)
      .where(eq(noteAnchors.noteEntryId, note.entryId));
    expect(anchorRows).toEqual([]);
    const promptRows = await context.db
      .select()
      .from(memoryPrompts)
      .where(eq(memoryPrompts.noteEntryId, note.entryId));
    expect(promptRows).toEqual([]);
  });

  it("rejects a standalone note whose body is blank or missing", async () => {
    const blank = await context.server.inject({
      method: "POST",
      payload: { bodyDoc: createTextDocument("   ") },
      url: "/api/notes"
    });
    expect(blank.statusCode).toBe(400);

    const missing = await context.server.inject({ method: "POST", payload: {}, url: "/api/notes" });
    expect(missing.statusCode).toBe(400);
  });

  it("reads any owned note by id, 404ing a forged or cross-user id", async () => {
    const created = (await createStandalone("Readable.")).json() as NoteDto;

    const got = await ownerGet(created.entryId);
    expect(got.statusCode).toBe(200);
    expect((got.json() as NoteDto).entryId).toBe(created.entryId);

    expect((await ownerGet("note-does-not-exist")).statusCode).toBe(404);

    const intruder = intruderServer();
    try {
      const cross = await intruder.inject({ method: "GET", url: `/api/notes/${created.entryId}` });
      // Dropping the owner predicate from getNoteForOwner would leak the note here.
      expect(cross.statusCode).toBe(404);
    } finally {
      await intruder.close();
    }
  });

  it("edits an owned note's body, 404ing a forged id and 409ing a bodyless mark", async () => {
    const created = (await createStandalone("Before.")).json() as NoteDto;

    const patched = await ownerPatch(created.entryId, { bodyDoc: createTextDocument("After.") });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as NoteDto).bodyText).toBe("After.");

    const blank = await ownerPatch(created.entryId, { bodyDoc: createTextDocument("   ") });
    expect(blank.statusCode).toBe(400);

    expect((await ownerPatch("nope", { bodyDoc: createTextDocument("x") })).statusCode).toBe(404);

    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId, plaintext);
    const editMark = await ownerPatch(mark.entryId, { bodyDoc: createTextDocument("x") });
    // A Mark has no editable body; the owner edit must reject it rather than fabricate one.
    expect(editMark.statusCode).toBe(409);

    const intruder = intruderServer();
    try {
      const cross = await intruder.inject({
        method: "PATCH",
        payload: { bodyDoc: createTextDocument("hijacked") },
        url: `/api/notes/${created.entryId}`
      });
      expect(cross.statusCode).toBe(404);
    } finally {
      await intruder.close();
    }
    // The note is untouched by the cross-user attempt.
    expect(((await ownerGet(created.entryId)).json() as NoteDto).bodyText).toBe("After.");
  });

  it("deletes an owned note and its review rows atomically, 404ing a forged or cross-user id", async () => {
    const created = (await createStandalone("Doomed.")).json() as NoteDto;
    await seedPrompt(created.entryId, {
      card: { dueAt: new Date("2026-05-01T00:00:00.000Z") },
      cueText: "What is doomed?"
    });

    const intruder = intruderServer();
    try {
      const cross = await intruder.inject({
        method: "DELETE",
        url: `/api/notes/${created.entryId}`
      });
      expect(cross.statusCode).toBe(404);
    } finally {
      await intruder.close();
    }
    // The cross-user delete was a no-op: the note (and its prompt) survive.
    expect((await ownerGet(created.entryId)).statusCode).toBe(200);

    const removed = await ownerDelete(created.entryId);
    expect(removed.statusCode).toBe(204);
    expect((await ownerGet(created.entryId)).statusCode).toBe(404);

    // The cascade tore down the prompt and its card in the same transaction.
    const promptRows = await context.db
      .select()
      .from(memoryPrompts)
      .where(eq(memoryPrompts.noteEntryId, created.entryId));
    expect(promptRows).toEqual([]);

    expect((await ownerDelete("already-gone")).statusCode).toBe(404);
  });

  it("narrows the list to one work's anchored notes with ?work=, excluding unanchored notes", async () => {
    const workA = await createWorkTitled("Work A", "Author A");
    const workB = await createWorkTitled("Work B", "Author B");
    context.setNow("2026-03-01T00:00:00.000Z");
    const inA = await createWholeBlockNote(workA.workEntryId, workA.blockEntryId, workA.plaintext);
    context.setNow("2026-03-02T00:00:00.000Z");
    const inB = await createWholeBlockNote(workB.workEntryId, workB.blockEntryId, workB.plaintext);
    context.setNow("2026-03-03T00:00:00.000Z");
    const standalone = (await createStandalone("Standalone.")).json() as NoteDto;

    const all = (await ownerList()).json() as NotesOverviewListDto;
    // Recency order: newest updated_at first.
    expect(all.notes.map((note) => note.entryId)).toEqual([
      standalone.entryId,
      inB.entryId,
      inA.entryId
    ]);

    const filtered = (await ownerList(`?work=${workA.workEntryId}`)).json() as NotesOverviewListDto;
    expect(filtered.notes.map((note) => note.entryId)).toEqual([inA.entryId]);
    // The unanchored standalone and the other work's note are both excluded.
    expect(filtered.notes.every((note) => note.workEntryId === workA.workEntryId)).toBe(true);
  });

  it("searches across body, anchor snapshot, prompt question, and legacy answer — each note once", async () => {
    const work = await createWorkWithBlock();
    const anchored = await createWholeBlockNote(
      work.workEntryId,
      work.blockEntryId,
      work.plaintext
    );
    const bodyNote = (await createStandalone("A peregrine dive.")).json() as NoteDto;
    const cueNote = (await createStandalone("Quiz card one.")).json() as NoteDto;
    await seedPrompt(cueNote.entryId, { cueText: "what is a kestrel bird" });
    const answerNote = (await createStandalone("Study set two.")).json() as NoteDto;
    await seedPrompt(answerNote.entryId, {
      answerText: "a hunting falcon",
      cueText: "define raptor",
      revealKind: "legacy_custom"
    });
    await seedPrompt(answerNote.entryId, {
      answerText: "also a falcon here",
      cueText: "another",
      revealKind: "legacy_custom"
    });
    const successNote = (await createStandalone("Systems set three.")).json() as NoteDto;
    await seedPrompt(successNote.entryId, {
      answerText: "names durability and ordering",
      cueText: "what does a WAL guarantee",
      revealKind: "expected_response"
    });

    const byBody = (await ownerList("?search=peregrine")).json() as NotesOverviewListDto;
    expect(byBody.notes.map((note) => note.entryId)).toEqual([bodyNote.entryId]);

    const byAnchor = (await ownerList("?search=brown%20fox")).json() as NotesOverviewListDto;
    expect(byAnchor.notes.map((note) => note.entryId)).toEqual([anchored.entryId]);

    const byCue = (await ownerList("?search=kestrel")).json() as NotesOverviewListDto;
    expect(byCue.notes.map((note) => note.entryId)).toEqual([cueNote.entryId]);

    // Case-insensitive, and de-duplicated even though two prompts on the same note match.
    const byAnswer = (await ownerList("?search=FALCON")).json() as NotesOverviewListDto;
    expect(byAnswer.notes.map((note) => note.entryId)).toEqual([answerNote.entryId]);

    // An expected_response prompt's authored Success check is learner content and is searchable too.
    const bySuccessCheck = (await ownerList("?search=durability")).json() as NotesOverviewListDto;
    expect(bySuccessCheck.notes.map((note) => note.entryId)).toEqual([successNote.entryId]);
  });

  it("ignores a blank search, returns nothing for a no-match query, and treats wildcards literally", async () => {
    context.setNow("2026-04-01T00:00:00.000Z");
    const withPercent = (await createStandalone("Contains 50% off today.")).json() as NoteDto;
    context.setNow("2026-04-02T00:00:00.000Z");
    const plain = (await createStandalone("Plain note.")).json() as NoteDto;

    // A blank query is ignored — the full recency list comes back.
    const blank = (await ownerList("?search=")).json() as NotesOverviewListDto;
    expect(blank.notes.map((note) => note.entryId)).toEqual([plain.entryId, withPercent.entryId]);

    const none = (await ownerList("?search=zzznomatch")).json() as NotesOverviewListDto;
    expect(none.notes).toEqual([]);

    // "%" is escaped, so it matches the literal characters rather than acting as a wildcard.
    const literalPercent = (await ownerList("?search=50%25")).json() as NotesOverviewListDto;
    expect(literalPercent.notes.map((note) => note.entryId)).toEqual([withPercent.entryId]);

    // "_" is escaped too, so "5_" does not wildcard-match the "50" in the note.
    const literalUnderscore = (await ownerList("?search=5_")).json() as NotesOverviewListDto;
    expect(literalUnderscore.notes).toEqual([]);
  });

  it("rolls each note's cards into one Review summary with due/scheduled/paused/not_enrolled precedence", async () => {
    context.setNow("2026-05-10T00:00:00.000Z");
    const dueNote = (await createStandalone("Due note.")).json() as NoteDto;
    const scheduledNote = (await createStandalone("Scheduled note.")).json() as NoteDto;
    const pausedNote = (await createStandalone("Paused note.")).json() as NoteDto;
    const plainNote = (await createStandalone("Plain note.")).json() as NoteDto;

    // Two active due cards on the same note roll up to one `due` with a count of 2.
    await seedPrompt(dueNote.entryId, {
      card: { dueAt: new Date("2026-05-09T00:00:00.000Z") },
      cueText: "cue"
    });
    await seedPrompt(dueNote.entryId, {
      answerText: "a",
      card: { dueAt: new Date("2026-05-08T00:00:00.000Z") },
      cueText: "legacy cue",
      revealKind: "legacy_custom"
    });
    await seedPrompt(scheduledNote.entryId, {
      card: { dueAt: new Date("2026-05-20T00:00:00.000Z") },
      cueText: "cue"
    });
    await seedPrompt(pausedNote.entryId, {
      card: { dueAt: new Date("2026-05-01T00:00:00.000Z"), status: "paused" },
      cueText: "cue"
    });

    const byId = new Map(
      ((await ownerList()).json() as NotesOverviewListDto).notes.map(
        (note) => [note.entryId, note.review] as const
      )
    );
    expect(byId.get(dueNote.entryId)).toEqual({ dueCount: 2, status: "due" });
    expect(byId.get(scheduledNote.entryId)).toEqual({
      nextReviewAt: "2026-05-20T00:00:00.000Z",
      status: "scheduled"
    });
    expect(byId.get(pausedNote.entryId)).toEqual({ status: "paused" });
    expect(byId.get(plainNote.entryId)).toEqual({ status: "not_enrolled" });
  });
});

describe("import notebook lists route (#661)", () => {
  function importItem(question: string, note: string): unknown {
    return { noteDoc: createTextDocument(note), questionDoc: createTextDocument(question) };
  }

  function postImport(payload: unknown): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "POST", payload, url: "/api/notes/import" });
  }

  it("creates one standalone note and one cardless prompt per row and returns them in pasted order", async () => {
    const response = await postImport({
      items: [
        importItem("What is a WAL?", "A write-ahead log records changes before applying them."),
        importItem("Define quorum", "A quorum is a majority of replicas.")
      ]
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as ImportNotesResultDto;
    expect(body.imported.map((row) => row.noteEntryId)).toEqual(["note-1", "note-3"]);
    expect(body.imported.map((row) => row.promptId)).toEqual(["note-2", "note-4"]);

    const noteRows = await context.db.select().from(notes);
    expect(noteRows).toHaveLength(2);
    for (const row of noteRows) {
      expect(row.kind).toBe("note");
      expect(row.captureSource).toBe("import");
    }

    const promptRows = await context.db.select().from(memoryPrompts);
    expect(promptRows).toHaveLength(2);
    for (const row of promptRows) {
      expect(row.revealKind).toBe("current_note");
      expect(row.answerText).toBeNull();
    }

    // Cardless: import never seeds Review.
    expect(await context.db.select().from(reviewCards)).toHaveLength(0);

    const owners = await context.db.select().from(personalEntries);
    expect(owners.every((row) => row.userId === DEFAULT_USER_ID)).toBe(true);
  });

  it("rejects a malformed import body at the boundary without writing any note", async () => {
    const empty = await postImport({ items: [] });
    expect(empty.statusCode).toBe(400);

    const blank = await postImport({
      items: [{ noteDoc: createTextDocument("   "), questionDoc: createTextDocument("q") }]
    });
    expect(blank.statusCode).toBe(400);

    expect(await context.db.select().from(notes)).toHaveLength(0);
    expect(await context.db.select().from(memoryPrompts)).toHaveLength(0);
  });
});
