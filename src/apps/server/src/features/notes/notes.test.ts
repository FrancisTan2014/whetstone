import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  NoteDto,
  NoteListDto,
  NoteTemplateListDto,
  WorkContentDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, entryLinks, noteAnchors, notes } from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { seedNoteTemplates, type NotesDependencies } from "./noteCommands.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  await seedNoteTemplates(db);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-notes-"));

  let workSequence = 0;
  let contentSequence = 0;
  let noteSequence = 0;
  let sourceSequence = 0;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(workSequence += 1)}`,
    createEntryId: () => `work-${workSequence}`,
    db
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(contentSequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  const notesDeps: NotesDependencies = {
    createEntryId: () => `note-${(noteSequence += 1)}`,
    db
  };

  return {
    db,
    server: createServer({ content, library, logger: false, notes: notesDeps }),
    sourcesDir
  };
}

async function createWorkWithBlock(): Promise<{
  blockEntryId: string;
  plaintext: string;
  workEntryId: string;
}> {
  const workResponse = await context.server.inject({
    method: "POST",
    payload: {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      title: "Fables",
      workType: "classical_text"
    },
    url: "/api/works"
  });
  const workEntryId = workResponse.json().work.entryId as string;

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox jumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const contentResponse = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/content`
  });
  const body = contentResponse.json() as WorkContentDto;
  const block = body.readingUnits[0]?.blocks[0];

  return {
    blockEntryId: block?.entryId as string,
    plaintext: block?.plaintext as string,
    workEntryId
  };
}

function postNote(workEntryId: string, payload: unknown): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "POST",
    payload,
    url: `/api/works/${workEntryId}/notes`
  });
}

async function createSubBlockNote(
  workEntryId: string,
  blockEntryId: string,
  plaintext: string
): Promise<NoteDto> {
  const response = await postNote(workEntryId, {
    answers: { meaning: "to outwit" },
    anchor: {
      blockEntryId,
      contextSnapshot: plaintext,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    },
    templateId: "vocabulary"
  });

  return response.json() as NoteDto;
}

async function createWholeBlockNote(
  workEntryId: string,
  blockEntryId: string,
  plaintext: string
): Promise<NoteDto> {
  const response = await postNote(workEntryId, {
    answers: { noticed: "A tidy aphorism." },
    anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
    templateId: "thought"
  });

  return response.json() as NoteDto;
}

function listNotes(workEntryId: string): ReturnType<typeof context.server.inject> {
  return context.server.inject({ method: "GET", url: `/api/works/${workEntryId}/notes` });
}

async function listContent(workEntryId: string): Promise<WorkContentDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/content`
  });

  return response.json() as WorkContentDto;
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

describe("note template routes", () => {
  it("lists the seeded templates in order", async () => {
    const response = await context.server.inject({ method: "GET", url: "/api/note-templates" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NoteTemplateListDto;
    expect(body.templates.map((template) => template.id)).toEqual([
      "vocabulary",
      "expression",
      "thought"
    ]);
    expect(body.templates[0]?.fields.map((field) => field.id)).toEqual([
      "meaning",
      "explanation",
      "memory_hook",
      "example"
    ]);
  });

  it("seeds idempotently", async () => {
    await seedNoteTemplates(context.db);

    const response = await context.server.inject({ method: "GET", url: "/api/note-templates" });
    expect((response.json() as NoteTemplateListDto).templates).toHaveLength(3);
  });
});

describe("create note route", () => {
  it("creates a sub-block note linked to its source block", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "to surrender", memory_hook: "" },
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(201);
    const note = response.json() as NoteDto;
    expect(note.templateId).toBe("vocabulary");
    expect(note.blockEntryId).toBe(blockEntryId);
    expect(note.answers).toEqual({ meaning: "to surrender", memory_hook: "" });
    expect(note.markdown).toBe("**Meaning in this context**\n\nto surrender");
    expect(note.anchor).toEqual({
      blockEntryId,
      contextSnapshot: plaintext,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });

    const noteRows = await context.db.select().from(notes).where(eq(notes.entryId, note.entryId));
    expect(noteRows[0]?.markdownBody).toBe("**Meaning in this context**\n\nto surrender");

    const anchorRows = await context.db
      .select()
      .from(noteAnchors)
      .where(eq(noteAnchors.noteEntryId, note.entryId));
    expect(anchorRows[0]?.blockEntryId).toBe(blockEntryId);
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
      answers: { noticed: "A tidy aphorism." },
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      templateId: "thought"
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

  it("rejects an unknown template", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "x" },
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      templateId: "missing"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "template_not_found" });
  });

  it("rejects answers that use an unknown field", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { mystery: "x" },
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answers", reason: "unknown_field" });
  });

  it("rejects a note with no non-blank answers", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "   " },
      anchor: { blockEntryId, contextSnapshot: plaintext, selectedTextSnapshot: plaintext },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answers", reason: "empty" });
  });

  it("returns 404 when the block is not part of the work", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "x" },
      anchor: {
        blockEntryId: "missing-block",
        contextSnapshot: "absent text",
        selectedTextSnapshot: "absent"
      },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "block_not_found" });
  });

  it("rejects a sub-block range that does not index the selected text", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "x" },
      anchor: {
        blockEntryId,
        contextSnapshot: plaintext,
        endOffset: 9,
        selectedTextSnapshot: "brown fox",
        startOffset: 0
      },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a forged context snapshot absent from the block text", async () => {
    const { blockEntryId, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "x" },
      anchor: {
        blockEntryId,
        contextSnapshot: "a sly brown fox from another tale",
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a whole-block selection absent from the block text", async () => {
    const { blockEntryId, workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, {
      answers: { meaning: "x" },
      anchor: {
        blockEntryId,
        contextSnapshot: "absent here",
        selectedTextSnapshot: "absent"
      },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "anchor_out_of_range" });
  });

  it("rejects a malformed request body at the boundary", async () => {
    const { workEntryId } = await createWorkWithBlock();

    const response = await postNote(workEntryId, { templateId: "vocabulary" });

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
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });
    expect(sub?.markdown).toBe("**Meaning in this context**\n\nto outwit");

    const whole = body.notes.find((note) => note.entryId === wholeBlock.entryId);
    expect(whole?.anchor.startOffset).toBeUndefined();
    expect(whole?.anchor.endOffset).toBeUndefined();
    expect(whole?.templateId).toBe("thought");
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

describe("update note route", () => {
  it("updates a note's answers and template and re-renders its markdown", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {
      answers: { noticed: "Now a thought." },
      templateId: "thought"
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as NoteDto;
    expect(updated.templateId).toBe("thought");
    expect(updated.answers).toEqual({ noticed: "Now a thought." });
    expect(updated.markdown).toBe("**What I noticed**\n\nNow a thought.");
    expect(updated.anchor).toEqual(note.anchor);

    const rows = await context.db.select().from(notes).where(eq(notes.entryId, note.entryId));
    expect(rows[0]?.templateId).toBe("thought");
    expect(rows[0]?.markdownBody).toBe("**What I noticed**\n\nNow a thought.");

    const listed = (await listNotes(workEntryId).then((r) => r.json())) as NoteListDto;
    expect(listed.notes[0]?.templateId).toBe("thought");
  });

  it("returns 404 when the note does not belong to the work", async () => {
    const first = await createWorkWithBlock();
    const note = await createSubBlockNote(first.workEntryId, first.blockEntryId, first.plaintext);
    const second = await createWorkWithBlock();

    const response = await patchNote(second.workEntryId, note.entryId, {
      answers: { noticed: "x" },
      templateId: "thought"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "note_not_found" });
  });

  it("rejects an unknown template", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {
      answers: { meaning: "x" },
      templateId: "missing"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "template_not_found" });
  });

  it("rejects answers with no non-blank value", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, {
      answers: { meaning: "  " },
      templateId: "vocabulary"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answers", reason: "empty" });
  });

  it("rejects a malformed update body at the boundary", async () => {
    const { blockEntryId, plaintext, workEntryId } = await createWorkWithBlock();
    const note = await createSubBlockNote(workEntryId, blockEntryId, plaintext);

    const response = await patchNote(workEntryId, note.entryId, { answers: { meaning: "x" } });

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
      answers: { noticed: "Still addressable." },
      templateId: "thought"
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
