import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkContentDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { blocks, workSources } from "../../db/schema.js";
import { createSourceFileStore, hashMarkdown } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import type { ContentDependencies } from "./contentCommands.js";
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
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-content-"));

  let authorSequence = 0;
  let workSequence = 0;
  let entrySequence = 0;
  let sourceSequence = 0;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(authorSequence += 1)}`,
    createEntryId: () => `work-${(workSequence += 1)}`,
    db
  };
  const content: ContentDependencies = {
    createEntryId: () => `entry-${(entrySequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return { db, server: createServer({ content, library, logger: false }), sourcesDir };
}

async function createWork(): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    payload: {
      author: { mode: "new", name: "George Orwell" },
      language: "en",
      title: "Politics and the English Language",
      workType: "essay"
    },
    url: "/api/works"
  });

  return response.json().work.entryId as string;
}

function ingest(workEntryId: string, payload: unknown): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "POST",
    payload,
    url: `/api/works/${workEntryId}/content`
  });
}

async function getContent(workEntryId: string): Promise<WorkContentDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/content`
  });

  return response.json() as WorkContentDto;
}

function blockIdByText(content: WorkContentDto): Map<string, string> {
  return new Map(
    content.readingUnits.flatMap((unit) =>
      unit.blocks.map((block) => [block.plaintext, block.entryId])
    )
  );
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
});

describe("content routes", () => {
  const markdown = "Intro.\n\n# Chapter One\n\n- a\n- b\n\n> quote";

  it("ingests manual Markdown into ordered reading units and blocks", async () => {
    const workEntryId = await createWork();

    const response = await ingest(workEntryId, { kind: "manual", markdown });

    expect(response.statusCode).toBe(201);
    const body = response.json() as WorkContentDto;
    expect(body.workEntryId).toBe(workEntryId);
    expect(body.readingUnits.map((unit) => unit.title)).toEqual([undefined, "Chapter One"]);
    expect(body.readingUnits.map((unit) => unit.orderIndex)).toEqual([0, 1]);
    expect(
      body.readingUnits.map((unit) =>
        unit.blocks.map((block) => [block.blockType, block.plaintext, block.orderIndex])
      )
    ).toEqual([
      [["paragraph", "Intro.", 0]],
      [
        ["heading", "Chapter One", 0],
        ["list", "ab", 1],
        ["blockquote", "quote", 2]
      ]
    ]);

    const headingBlock = body.readingUnits
      .flatMap((unit) => unit.blocks)
      .find((block) => block.blockType === "heading");
    expect(headingBlock?.mdast).toMatchObject({ depth: 1, type: "heading" });

    const listed = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/content`
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(body);
  });

  it("replaces a work's content on re-ingestion instead of appending", async () => {
    const workEntryId = await createWork();

    await ingest(workEntryId, { kind: "manual", markdown: "# One\n\nA" });
    await ingest(workEntryId, { kind: "manual", markdown: "# Two\n\nB" });

    const body = await getContent(workEntryId);
    expect(body.readingUnits.map((unit) => unit.title)).toEqual(["Two"]);
    expect(
      body.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext))
    ).toEqual(["Two", "B"]);
    expect(body.readingUnits.map((unit) => unit.orderIndex)).toEqual([0]);
  });

  it("preserves block ids across edits and inserts and soft-deletes removed blocks", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, {
      kind: "manual",
      markdown:
        "The quick brown fox jumps over the lazy dog.\n\nSecond paragraph stays the same.\n\nThird paragraph to be removed."
    });
    const firstIds = blockIdByText(await getContent(workEntryId));
    const removedId = firstIds.get("Third paragraph to be removed.");

    await ingest(workEntryId, {
      kind: "manual",
      markdown:
        "The quick brown fox jumps over the lazy cat.\n\nSecond paragraph stays the same.\n\nA brand new closing paragraph."
    });

    const second = await getContent(workEntryId);
    const secondBlocks = second.readingUnits.flatMap((unit) => unit.blocks);
    const secondIdByText = new Map(secondBlocks.map((block) => [block.plaintext, block.entryId]));

    // Unchanged block keeps its id.
    expect(secondIdByText.get("Second paragraph stays the same.")).toBe(
      firstIds.get("Second paragraph stays the same.")
    );
    // Lightly-edited block keeps its id (dog -> cat).
    expect(secondIdByText.get("The quick brown fox jumps over the lazy cat.")).toBe(
      firstIds.get("The quick brown fox jumps over the lazy dog.")
    );
    // Genuinely new block gets a fresh id.
    expect(secondIdByText.get("A brand new closing paragraph.")).toBeDefined();
    expect([...firstIds.values()]).not.toContain(
      secondIdByText.get("A brand new closing paragraph.")
    );

    // Removed block is soft-deleted: row still exists (note anchors stay valid) but is
    // detached and excluded from the reader.
    expect(secondBlocks.map((block) => block.plaintext)).not.toContain(
      "Third paragraph to be removed."
    );
    const removedRows = await context.db
      .select()
      .from(blocks)
      .where(eq(blocks.entryId, removedId as string));
    expect(removedRows[0]?.deletedAt).not.toBeNull();
    expect(removedRows[0]?.readingUnitEntryId).toBeNull();
  });

  it("is a no-op when re-ingesting an identical source", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown });
    const first = await getContent(workEntryId);
    const sourcesBefore = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));

    await ingest(workEntryId, { kind: "manual", markdown });
    const second = await getContent(workEntryId);
    const sourcesAfter = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));

    expect(second).toEqual(first);
    expect(sourcesAfter).toHaveLength(sourcesBefore.length);
  });

  it("removes all content when re-ingesting a source with no supported blocks", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: "Alpha\n\nBeta" });

    await ingest(workEntryId, { kind: "manual", markdown: "---" });

    const body = await getContent(workEntryId);
    expect(body.readingUnits).toEqual([]);
    const remaining = await context.db.select().from(blocks);
    expect(remaining.every((block) => block.deletedAt !== null)).toBe(true);
  });

  it("exports a work's Markdown reconstructed from its blocks", async () => {
    const workEntryId = await createWork();
    const source = "# Title\n\nA paragraph.\n\n- one\n- two";
    await ingest(workEntryId, { kind: "manual", markdown: source });

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/content/markdown`
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");

    // Round-trip: the exported Markdown re-ingests into the same structure.
    const roundTripWork = await createWork();
    await ingest(roundTripWork, { kind: "manual", markdown: response.body });
    const original = await getContent(workEntryId);
    const roundTripped = await getContent(roundTripWork);
    expect(
      roundTripped.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext))
    ).toEqual(original.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext)));
    expect(roundTripped.readingUnits.map((unit) => unit.title)).toEqual(
      original.readingUnits.map((unit) => unit.title)
    );
  });

  it("returns 404 when exporting Markdown for a missing work", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/works/missing-work/content/markdown"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("retains manual input as source text with its sha256", async () => {
    const workEntryId = await createWork();

    await ingest(workEntryId, { kind: "manual", markdown });

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    expect(sources).toHaveLength(1);
    const source = sources[0];
    expect(source?.kind).toBe("manual");
    expect(source?.sourceText).toBe(markdown);
    expect(source?.filePath).toBeNull();
    expect(source?.fileName).toBeNull();
    expect(source?.sha256).toBe(hashMarkdown(markdown));
  });

  it("retains an uploaded .md file on disk with its path and sha256", async () => {
    const workEntryId = await createWork();

    const response = await ingest(workEntryId, {
      fileName: "notes.md",
      kind: "upload",
      markdown
    });
    expect(response.statusCode).toBe(201);

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    const source = sources[0];
    expect(source?.kind).toBe("upload");
    expect(source?.fileName).toBe("notes.md");
    expect(source?.sourceText).toBeNull();
    expect(source?.filePath).toBe("source-1.md");
    expect(source?.sha256).toBe(hashMarkdown(markdown));

    const onDisk = await readFile(join(context.sourcesDir, "source-1.md"), "utf8");
    expect(onDisk).toBe(markdown);
  });

  it("records a source but no units for content without supported blocks", async () => {
    const workEntryId = await createWork();

    const response = await ingest(workEntryId, { kind: "manual", markdown: "---" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ readingUnits: [], workEntryId });

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    expect(sources).toHaveLength(1);
  });

  it("returns 404 when ingesting into a missing work", async () => {
    const response = await ingest("missing-work", { kind: "manual", markdown });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("rejects invalid ingestion payloads at the boundary", async () => {
    const workEntryId = await createWork();

    const blankManual = await ingest(workEntryId, { kind: "manual", markdown: "   " });
    expect(blankManual.statusCode).toBe(400);
    expect(blankManual.json()).toEqual({ error: "invalid_request" });

    const nonMarkdownUpload = await ingest(workEntryId, {
      fileName: "notes.txt",
      kind: "upload",
      markdown
    });
    expect(nonMarkdownUpload.statusCode).toBe(400);
  });

  it("returns 404 when listing content for a missing work", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/works/missing-work/content"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("returns empty content for a work that has none yet", async () => {
    const workEntryId = await createWork();

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/content`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ readingUnits: [], workEntryId });
  });
});
