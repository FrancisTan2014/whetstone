import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkContentDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { workSources } from "../../db/schema.js";
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

  it("appends later ingestions and continues reading-unit ordering", async () => {
    const workEntryId = await createWork();

    await ingest(workEntryId, { kind: "manual", markdown: "# One\n\nA" });
    await ingest(workEntryId, { kind: "manual", markdown: "# Two\n\nB" });

    const listed = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/content`
    });
    const body = listed.json() as WorkContentDto;
    expect(body.readingUnits.map((unit) => unit.title)).toEqual(["One", "Two"]);
    expect(body.readingUnits.map((unit) => unit.orderIndex)).toEqual([0, 1]);
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
