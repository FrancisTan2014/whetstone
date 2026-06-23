import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NoteDto, NoteTemplateListDto, WorkContentDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entryLinks, noteAnchors, notes } from "../../db/schema.js";
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

async function createWorkWithBlock(): Promise<{ blockEntryId: string; plaintext: string; workEntryId: string }> {
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

  return { blockEntryId: block?.entryId as string, plaintext: block?.plaintext as string, workEntryId };
}

function postNote(workEntryId: string, payload: unknown): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "POST",
    payload,
    url: `/api/works/${workEntryId}/notes`
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
    expect(links).toEqual([{ fromEntryId: note.entryId, toEntryId: blockEntryId, type: "annotates" }]);
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
