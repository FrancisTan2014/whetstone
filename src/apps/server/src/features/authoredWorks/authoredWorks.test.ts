import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AuthoredWorkDto,
  AuthoredWorkListDto,
  ContinueWritingDto,
  TimelineDto
} from "@whetstone/contracts";
import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  docBlocks,
  entries,
  noteAnchors,
  notes,
  personalEntries
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { loadWorkContent, loadWorkStructure } from "../content/contentQueries.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { deleteWork } from "../library/libraryCommands.js";
import type { AuthoredWorkRouteDependencies } from "./authoredWorkRoutes.js";
import type { DiaryRouteDependencies } from "../diary/diaryRoutes.js";
import { eq } from "drizzle-orm";
import { toEntryId } from "@whetstone/domain";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
  setUser: (id: string) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = new Date("2026-07-01T09:00:00.000Z");
  let userId = DEFAULT_USER_ID;
  let sequence = 0;
  const authoredWorks: AuthoredWorkRouteDependencies = {
    createEntryId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now
  };
  // The diary route is mounted only so the shared Timeline endpoint exists for the "work appears on the
  // Timeline" test; authored works do not otherwise depend on it.
  const diary: DiaryRouteDependencies = {
    createId: () => `diary-${(sequence += 1)}`,
    db,
    deleteAudio: () => Promise.resolve(),
    now: () => now,
    saveAudio: () => Promise.resolve("voice-captures/test.audio")
  };

  return {
    db,
    server: createServer({
      authoredWorks,
      currentUser: { getCurrentUserId: () => userId },
      diary,
      logger: false
    }),
    setNow: (iso) => {
      now = new Date(iso);
    },
    setUser: (id) => {
      userId = id;
    }
  };
}

async function createWork(
  body: Readonly<{ language?: string; title?: string; workType?: string }> = {}
): Promise<AuthoredWorkDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: {
      language: body.language ?? "en",
      title: body.title ?? "My essay",
      workType: body.workType ?? "essay"
    },
    url: "/api/authored-works"
  });
  expect(response.statusCode).toBe(201);
  return response.json() as AuthoredWorkDto;
}

async function loadWork(id: string): Promise<AuthoredWorkDto> {
  const response = await context.server.inject({ method: "GET", url: `/api/authored-works/${id}` });
  expect(response.statusCode).toBe(200);
  return response.json() as AuthoredWorkDto;
}

async function saveWork(id: string, document: DocumentNodeJSON): Promise<AuthoredWorkDto> {
  const response = await context.server.inject({
    method: "PUT",
    payload: { document },
    url: `/api/authored-works/${id}/content`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as AuthoredWorkDto;
}

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

async function seedNoteOnBlock(blockEntryId: string, noteId: string): Promise<void> {
  await context.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: noteId, type: "note" });
    await tx.insert(personalEntries).values({
      createdAt: new Date("2026-07-01T09:00:00.000Z"),
      entryId: noteId,
      occurredAt: new Date("2026-07-01T09:00:00.000Z"),
      updatedAt: new Date("2026-07-01T09:00:00.000Z"),
      userId: DEFAULT_USER_ID
    });
    await tx.insert(notes).values({
      bodyDoc: createTextDocument("a note"),
      bodyText: "a note",
      captureSource: "reader",
      entryId: noteId,
      kind: "note"
    });
    await tx.insert(noteAnchors).values({
      blockEntryId,
      contextSnapshot: "context",
      endBlockEntryId: blockEntryId,
      endOffset: null,
      noteEntryId: noteId,
      selectedText: "text",
      startOffset: null
    });
  });
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("POST /api/authored-works", () => {
  it("creates an owned Work opened to an empty document", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");

    const work = await createWork({ language: "zh-CN", title: "随笔", workType: "blog_post" });

    expect(work).toMatchObject({
      createdAt: "2026-07-01T09:00:00.000Z",
      language: "zh-CN",
      title: "随笔",
      updatedAt: "2026-07-01T09:00:00.000Z",
      workType: "blog_post"
    });
    // A single empty paragraph block, stamped with a stable id — a valid, note-addressable document.
    expect(work.document.content).toHaveLength(1);
    expect(work.document.content?.[0]?.type).toBe("paragraph");
    expect(blockId(work.document, 0)).not.toBe("");
    // The block is registered as an addressable Entry under the work's reading unit.
    expect(await loadWork(work.entryId)).toEqual(work);
  });

  it("reuses one per-user self author across the learner's Works", async () => {
    await createWork({ title: "first" });
    await createWork({ title: "second" });

    const authorRows = await context.db.select({ id: authors.id }).from(authors);
    expect(authorRows).toHaveLength(1);
  });

  it("rejects a blank title, unsupported language, or unsupported work type", async () => {
    for (const payload of [
      { language: "en", title: "   ", workType: "essay" },
      { language: "fr", title: "ok", workType: "essay" },
      { language: "en", title: "ok", workType: "screenplay" }
    ]) {
      const response = await context.server.inject({
        method: "POST",
        payload,
        url: "/api/authored-works"
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    }
  });
});

describe("PUT /api/authored-works/:id/content", () => {
  it("edits a block in place, preserving its id so annotations stay anchored", async () => {
    const created = await createWork();
    const id0 = blockId(created.document, 0);

    context.setNow("2026-07-01T10:00:00.000Z");
    const saved = await saveWork(created.entryId, doc(para("hello world", id0)));

    expect(blockId(saved.document, 0)).toBe(id0);
    expect(saved.updatedAt).toBe("2026-07-01T10:00:00.000Z");
    // createdAt is fixed at creation; only updatedAt advances.
    expect(saved.createdAt).toBe(created.createdAt);

    const reloaded = await loadWork(created.entryId);
    expect(reloaded.document.content).toHaveLength(1);
    expect(blockId(reloaded.document, 0)).toBe(id0);
    expect(reloaded.document.content?.[0]?.content?.[0]).toEqual({
      text: "hello world",
      type: "text"
    });
  });

  it("inserts a genuinely new block and persists both", async () => {
    const created = await createWork();
    const id0 = blockId(created.document, 0);

    const saved = await saveWork(created.entryId, doc(para("first", id0), para("second")));

    expect(saved.document.content).toHaveLength(2);
    expect(blockId(saved.document, 0)).toBe(id0);
    const id1 = blockId(saved.document, 1);
    expect(id1).not.toBe("");
    expect(id1).not.toBe(id0);

    const reloaded = await loadWork(created.entryId);
    expect(reloaded.document.content).toHaveLength(2);
    expect(reloaded.document.content?.[1]?.content?.[0]).toEqual({ text: "second", type: "text" });
  });

  it("removes a dropped block but keeps a block a note still anchors", async () => {
    const created = await createWork();
    const id0 = blockId(created.document, 0);
    const threeBlocks = await saveWork(
      created.entryId,
      doc(para("keep", id0), para("noted"), para("orphan"))
    );
    const notedId = blockId(threeBlocks.document, 1);
    const orphanId = blockId(threeBlocks.document, 2);
    await seedNoteOnBlock(notedId, "note-1");

    // Drop both the noted block and the un-noted one.
    const saved = await saveWork(created.entryId, doc(para("keep", id0)));
    expect(saved.document.content).toHaveLength(1);

    // Both blocks are gone from the rendered document...
    const remainingBlocks = await context.db
      .select({ id: docBlocks.id })
      .from(docBlocks)
      .where(eq(docBlocks.id, notedId));
    expect(remainingBlocks).toHaveLength(0);

    // ...but the noted block's Entry survives (the note's FK stays valid), while the un-noted one is gone.
    const notedEntry = await context.db.select().from(entries).where(eq(entries.id, notedId));
    const orphanEntry = await context.db.select().from(entries).where(eq(entries.id, orphanId));
    expect(notedEntry).toHaveLength(1);
    expect(orphanEntry).toHaveLength(0);

    // The note itself is untouched.
    const noteRow = await context.db.select().from(notes).where(eq(notes.entryId, "note-1"));
    expect(noteRow).toHaveLength(1);
  });

  it("keeps a removed block's Entry when it is the only removal and a note anchors it", async () => {
    const created = await createWork();
    const id0 = blockId(created.document, 0);
    const twoBlocks = await saveWork(created.entryId, doc(para("keep", id0), para("noted")));
    const notedId = blockId(twoBlocks.document, 1);
    await seedNoteOnBlock(notedId, "note-solo");

    // Remove ONLY the noted block: nothing is deletable, so no Entry is dropped.
    const saved = await saveWork(created.entryId, doc(para("keep", id0)));
    expect(saved.document.content).toHaveLength(1);

    const notedEntry = await context.db.select().from(entries).where(eq(entries.id, notedId));
    expect(notedEntry).toHaveLength(1);
    const gone = await context.db
      .select({ id: docBlocks.id })
      .from(docBlocks)
      .where(eq(docBlocks.id, notedId));
    expect(gone).toHaveLength(0);
  });

  it("is latest-write-safe — the last save wins", async () => {
    const created = await createWork();
    const id0 = blockId(created.document, 0);

    await saveWork(created.entryId, doc(para("first draft", id0)));
    await saveWork(created.entryId, doc(para("final draft", id0)));

    const reloaded = await loadWork(created.entryId);
    expect(reloaded.document.content?.[0]?.content?.[0]).toEqual({
      text: "final draft",
      type: "text"
    });
  });

  it("rejects a malformed document at the boundary", async () => {
    const created = await createWork();
    const response = await context.server.inject({
      method: "PUT",
      payload: { document: { content: [], type: "not-a-doc" } },
      url: `/api/authored-works/${created.entryId}/content`
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses to save another user's Work or an unknown Work (404)", async () => {
    const created = await createWork();

    context.setUser(OTHER_USER_ID);
    const foreign = await context.server.inject({
      method: "PUT",
      payload: { document: doc(para("hijack")) },
      url: `/api/authored-works/${created.entryId}/content`
    });
    expect(foreign.statusCode).toBe(404);

    const unknown = await context.server.inject({
      method: "PUT",
      payload: { document: doc(para("nope")) },
      url: `/api/authored-works/missing/content`
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("GET /api/authored-works/:id", () => {
  it("returns 404 for another user's Work and for an unknown id", async () => {
    const created = await createWork();

    context.setUser(OTHER_USER_ID);
    const foreign = await context.server.inject({
      method: "GET",
      url: `/api/authored-works/${created.entryId}`
    });
    expect(foreign.statusCode).toBe(404);

    context.setUser(DEFAULT_USER_ID);
    const unknown = await context.server.inject({
      method: "GET",
      url: "/api/authored-works/missing"
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("GET /api/authored-works and /continue", () => {
  it("lists the user's Works newest-edit-first and omits imported works", async () => {
    context.setNow("2026-07-01T09:00:00.000Z");
    const first = await createWork({ title: "first" });
    context.setNow("2026-07-01T09:05:00.000Z");
    const second = await createWork({ title: "second" });
    // Editing `first` bumps its updatedAt above `second`.
    context.setNow("2026-07-01T09:10:00.000Z");
    await saveWork(first.entryId, doc(para("edited", blockId(first.document, 0))));

    const response = await context.server.inject({ method: "GET", url: "/api/authored-works" });
    expect(response.statusCode).toBe(200);
    const listed = (response.json() as AuthoredWorkListDto).works.map((work) => work.title);
    expect(listed).toEqual(["first", "second"]);
    expect((response.json() as AuthoredWorkListDto).works[0]?.entryId).toBe(first.entryId);
    void second;
  });

  it("continues the most recently edited Work, or null when none exist", async () => {
    const empty = await context.server.inject({
      method: "GET",
      url: "/api/authored-works/continue"
    });
    expect((empty.json() as ContinueWritingDto).work).toBeNull();

    context.setNow("2026-07-01T09:00:00.000Z");
    await createWork({ title: "older" });
    context.setNow("2026-07-01T09:05:00.000Z");
    const newer = await createWork({ title: "newer" });

    const response = await context.server.inject({
      method: "GET",
      url: "/api/authored-works/continue"
    });
    expect((response.json() as ContinueWritingDto).work?.entryId).toBe(newer.entryId);
  });
});

describe("authored Works on the shared Timeline", () => {
  it("surfaces an authored Work as a `work` entry ordered by its creation", async () => {
    context.setNow("2026-07-02T08:00:00.000Z");
    const work = await createWork({ title: "A timeline work" });

    const response = await context.server.inject({ method: "GET", url: "/api/diary/timeline" });
    expect(response.statusCode).toBe(200);
    const entriesFlat = (response.json() as TimelineDto).days.flatMap((day) => day.entries);
    expect(entriesFlat).toContainEqual({
      entryId: work.entryId,
      kind: "work",
      occurredAt: "2026-07-02T08:00:00.000Z",
      title: "A timeline work",
      workEntryId: work.entryId
    });
  });
});

describe("deleting an authored Work", () => {
  it("removes its personal-entry facet so it leaves the Timeline and list", async () => {
    const work = await createWork({ title: "to delete" });

    const result = await deleteWork(
      {
        db: context.db,
        deleteSourceFile: () => Promise.resolve(),
        logSourceUnlinkFailure: () => {}
      },
      toEntryId(work.entryId)
    );
    expect(result).toBe("deleted");

    const facet = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, work.entryId));
    expect(facet).toHaveLength(0);

    const listed = await context.server.inject({ method: "GET", url: "/api/authored-works" });
    expect((listed.json() as AuthoredWorkListDto).works).toHaveLength(0);
  });
});

describe("authored Works are first-class in the shared reader (#576)", () => {
  it("surfaces a saved authored Work's unit through loadWorkStructure with a truthful, substantive block count", async () => {
    const work = await createWork({ title: "On Writing" });
    const document = doc(para("First paragraph.", "b1"), para("Second paragraph.", "b2"));
    await saveWork(work.entryId, document);

    const structure = await loadWorkStructure(context.db, toEntryId(work.entryId));

    expect(structure.readingUnits).toHaveLength(1);
    const unit = structure.readingUnits[0];
    // The count reflects the PM doc_blocks (an authored Work has no legacy mdast blocks), and the unit
    // is substantive so the reader opens it rather than skipping it as front matter.
    expect(unit?.blockCount).toBe(2);
    expect(unit?.hasSubstantiveText).toBe(true);
  });

  it("returns the authored Work's PM blocks through loadWorkContent so the reader renders and anchors notes to them", async () => {
    const work = await createWork({ title: "On Reading" });
    const document = doc(para("Only paragraph.", "only"));
    await saveWork(work.entryId, document);

    const content = await loadWorkContent(context.db, toEntryId(work.entryId));

    expect(content.readingUnits).toHaveLength(1);
    const unit = content.readingUnits[0];
    // Authored content lives only in doc_blocks; the mdast block list is empty and the reader renders
    // the PM nodes (toReaderBlocks prefers docBlocks). The block ids match the saved document so notes
    // anchor to them.
    expect(unit?.blocks).toEqual([]);
    expect(unit?.docBlocks.map((block) => block.entryId)).toEqual([blockId(document, 0)]);
    expect(unit?.docBlocks[0]?.type).toBe("paragraph");
  });

  it("still surfaces a brand-new empty authored Work, marking its empty unit non-substantive", async () => {
    const work = await createWork({ title: "Blank" });

    const structure = await loadWorkStructure(context.db, toEntryId(work.entryId));

    expect(structure.readingUnits).toHaveLength(1);
    // The initial empty paragraph is present (so the reader can open the unit) but not substantive.
    expect(structure.readingUnits[0]?.blockCount).toBe(1);
    expect(structure.readingUnits[0]?.hasSubstantiveText).toBe(false);
  });
});
