import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  epubContentType,
  pdfContentType,
  type BlockUnitLocatorDto,
  type IngestEpubResultDto,
  type ReadingUnitContentDto,
  type WorkContentDto,
  type WorkStructureDto
} from "@whetstone/contracts";
import { decomposeHtmlChapter, decomposeMarkdown, toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  entries,
  readingPositions,
  readingUnits,
  workSources
} from "../../db/schema.js";
import { loadWorkContent } from "./contentQueries.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore, hashBytes, hashMarkdown } from "../../files/sourceFileStore.js";
import type { ParsedEpub, ParsedEpubImage } from "../../files/epubSource.js";
import { createServer } from "../../http/createServer.js";
import type { ContentDependencies } from "./contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";

type TestContext = Readonly<{
  db: DbClient;
  imagesDir: string;
  pglite: PGlite;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
}>;

let context: TestContext;
let epubResponder: (bytes: Uint8Array) => Promise<ParsedEpub>;
let pdfResponder: () => Promise<string>;
let epubUploadLimitBytes: number;

function twoChapterEpub(): ParsedEpub {
  return {
    chapters: [
      { html: "<h1>Chapter One</h1><p>First.</p>", images: [] },
      { html: "<h1>本纪</h1><p>黄帝者。</p>", images: [] }
    ],
    metadata: { author: "司马迁", language: "zh-CN", title: "史记选读" }
  };
}

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-content-"));
  const imagesDir = await mkdtemp(join(tmpdir(), "whetstone-content-img-"));

  let authorSequence = 0;
  let workSequence = 0;
  let entrySequence = 0;
  let sourceSequence = 0;
  let contentAuthorSequence = 0;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(authorSequence += 1)}`,
    createEntryId: () => `work-${(workSequence += 1)}`,
    db
  };
  const content: ContentDependencies = {
    createAuthorId: () => `epub-author-${(contentAuthorSequence += 1)}`,
    createEntryId: () => `entry-${(entrySequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    epubParser: (bytes) => epubResponder(bytes),
    epubUploadLimitBytes,
    imageResourceStore: createImageResourceStore(imagesDir),
    pdfToMarkdown: { convert: () => pdfResponder() },
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return {
    db,
    imagesDir,
    pglite,
    server: createServer({ content, library, logger: false }),
    sourcesDir
  };
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

function ingestPdf(workEntryId: string, bytes: Buffer): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    headers: { "content-type": pdfContentType },
    method: "POST",
    payload: bytes,
    url: `/api/works/${workEntryId}/content/pdf`
  });
}

async function getContent(workEntryId: string): Promise<WorkContentDto> {
  return loadWorkContent(context.db, toEntryId(workEntryId));
}

function blockIdByText(content: WorkContentDto): Map<string, string> {
  return new Map(
    content.readingUnits.flatMap((unit) =>
      unit.blocks.map((block) => [block.plaintext, block.entryId])
    )
  );
}

function ingestEpub(bytes: Buffer): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    headers: { "content-type": epubContentType },
    method: "POST",
    payload: bytes,
    url: "/api/works/epub"
  });
}

async function createAuthorNamed(name: string): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    payload: { name },
    url: "/api/authors"
  });

  return response.json().id as string;
}

beforeEach(async () => {
  epubResponder = async () => twoChapterEpub();
  pdfResponder = async () => "# PDF\n\nConverted body.";
  epubUploadLimitBytes = 50 * 1024 * 1024;
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
  await rm(context.imagesDir, { force: true, recursive: true });
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

    const listed = await getContent(workEntryId);
    expect(listed).toEqual(body);
  });

  it("preserves a GFM table as a table block in the ingested content", async () => {
    const workEntryId = await createWork();
    const tableMarkdown = [
      "# Table Fixture",
      "",
      "A paragraph before the table.",
      "",
      "| Term | Meaning |",
      "| --- | --- |",
      "| whetstone | sharpening surface |",
      "| reader | focused reading UI |",
      "",
      "A paragraph after the table."
    ].join("\n");

    const response = await ingest(workEntryId, { kind: "manual", markdown: tableMarkdown });

    expect(response.statusCode).toBe(201);
    const blocks = (response.json() as WorkContentDto).readingUnits.flatMap((unit) => unit.blocks);
    expect(blocks.map((block) => block.blockType)).toEqual([
      "heading",
      "paragraph",
      "table",
      "paragraph"
    ]);
    const table = blocks.find((block) => block.blockType === "table");
    expect(table?.plaintext).toContain("whetstone");
    expect((table?.mdast as { type: string }).type).toBe("table");
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

  it("re-ingests Markdown after the work was opened in the Reader, clearing the stale reading position", async () => {
    // Opening a work in the Reader saves a reading position referencing one of the work's unit
    // entries. Re-ingestion replaces (and deletes) those unit entries, so the position must be
    // cleared first — otherwise its dangling FK rolls the whole re-ingestion back (a 500).
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: "Alpha block.\n\nBeta block." });
    const before = await getContent(workEntryId);
    const unitId = before.readingUnits[0]?.entryId as string;
    const blockId = before.readingUnits[0]?.blocks[0]?.entryId as string;

    await context.db.insert(readingPositions).values({
      anchorBlockEntryId: blockId,
      unitEntryId: unitId,
      userId: "default-user",
      workEntryId: toEntryId(workEntryId)
    });

    const response = await ingest(workEntryId, {
      kind: "manual",
      markdown: "Gamma block.\n\nDelta block."
    });

    expect(response.statusCode).toBe(201);
    const after = await getContent(workEntryId);
    expect(
      after.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext))
    ).toEqual(["Gamma block.", "Delta block."]);

    // The stale position is cleared so the reader resumes at the start.
    const positions = await context.db
      .select()
      .from(readingPositions)
      .where(eq(readingPositions.workEntryId, toEntryId(workEntryId)));
    expect(positions).toEqual([]);
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

  it("rejects a re-ingestion that has no supported blocks and keeps the existing content", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: "Alpha\n\nBeta" });

    const response = await ingest(workEntryId, { kind: "manual", markdown: "---" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "empty_content" });

    // The existing content is preserved — unsupported content never silently wipes the work.
    const body = await getContent(workEntryId);
    expect(
      body.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext))
    ).toEqual(["Alpha", "Beta"]);
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

  it("ingests a PDF to identical blocks as the equivalent Markdown upload (golden)", async () => {
    const pdfMarkdown = "Intro.\n\n# Chapter One\n\n- a\n- b\n\n> quote";
    pdfResponder = async () => pdfMarkdown;

    const pdfWork = await createWork();
    expect((await ingestPdf(pdfWork, Buffer.from("%PDF-1.7 bytes"))).statusCode).toBe(201);

    const mdWork = await createWork();
    await ingest(mdWork, { kind: "manual", markdown: pdfMarkdown });

    const fromPdf = await getContent(pdfWork);
    const fromMd = await getContent(mdWork);
    const plaintexts = (content: WorkContentDto): string[] =>
      content.readingUnits.flatMap((unit) => unit.blocks.map((block) => block.plaintext));
    expect(plaintexts(fromPdf)).toEqual(plaintexts(fromMd));
    expect(fromPdf.readingUnits.map((unit) => unit.title)).toEqual(
      fromMd.readingUnits.map((unit) => unit.title)
    );
  });

  it("returns 422 when the PDF worker fails to convert", async () => {
    pdfResponder = async () => Promise.reject(new Error("docling absent"));
    const workEntryId = await createWork();

    const response = await ingestPdf(workEntryId, Buffer.from("%PDF"));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_pdf" });
  });

  it("rejects an empty PDF body with 400", async () => {
    const workEntryId = await createWork();
    expect((await ingestPdf(workEntryId, Buffer.alloc(0))).statusCode).toBe(400);
  });

  it("returns 422 for a PDF whose Markdown has no readable blocks", async () => {
    pdfResponder = async () => "![only image](x.png)";
    const workEntryId = await createWork();
    expect((await ingestPdf(workEntryId, Buffer.from("%PDF"))).statusCode).toBe(422);
  });

  it("returns 404 ingesting a PDF into a missing work", async () => {
    expect((await ingestPdf("missing-work", Buffer.from("%PDF"))).statusCode).toBe(404);
  });

  it("rejects image-only Markdown that has no supported blocks and records no source", async () => {
    const workEntryId = await createWork();

    const response = await ingest(workEntryId, {
      kind: "manual",
      markdown: "![Decorative only](missing.png)"
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "empty_content" });
    expect((await getContent(workEntryId)).readingUnits).toEqual([]);

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    expect(sources).toHaveLength(0);
  });

  it("returns 404 when ingesting into a missing work", async () => {
    const response = await ingest("missing-work", { kind: "manual", markdown });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("surfaces a 5xx when the database rejects during ingestion", async () => {
    const workEntryId = await createWork();
    // Drop the database connection so the next query rejects.
    await context.pglite.close();

    const response = await ingest(workEntryId, { kind: "manual", markdown });

    // A db failure must surface as a server error, not a hang or a false 2xx.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
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

  it("loads empty content for a work that has none yet", async () => {
    const workEntryId = await createWork();

    expect(await getContent(workEntryId)).toEqual({ readingUnits: [], workEntryId });
  });

  it("persists every block of a Markdown source large enough to exceed the parameter limit", async () => {
    const workEntryId = await createWork();
    const paragraphCount = 6000; // 6000 blocks × 8 columns ≈ 48000 params (> the 32767 limit)
    const largeMarkdown = Array.from(
      { length: paragraphCount },
      (_, index) => `Paragraph ${index} carrying enough words to be a distinct block.`
    ).join("\n\n");
    const expectedBlockCount = decomposeMarkdown(largeMarkdown).reduce(
      (total, unit) => total + unit.blocks.length,
      0
    );

    const response = await ingest(workEntryId, { kind: "manual", markdown: largeMarkdown });
    expect(response.statusCode).toBe(201);

    const persisted = await getContent(workEntryId);
    const persistedBlockCount = persisted.readingUnits.reduce(
      (total, unit) => total + unit.blocks.length,
      0
    );
    expect(expectedBlockCount).toBeGreaterThan(5000);
    expect(persistedBlockCount).toBe(expectedBlockCount);
    expect(await context.db.select().from(blocks)).toHaveLength(expectedBlockCount);
  }, 30000);
});

describe("EPUB ingestion routes", () => {
  it("creates a work whose chapters become ordered reading units of blocks", async () => {
    const bytes = Buffer.from("epub-bytes-1");

    const response = await ingestEpub(bytes);

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    expect(body.work).toMatchObject({ language: "zh-CN", title: "史记选读", workType: "book" });
    expect(body.content.workEntryId).toBe(body.work.entryId);
    expect(body.content.readingUnits.map((unit) => [unit.title, unit.orderIndex])).toEqual([
      ["Chapter One", 0],
      ["本纪", 1]
    ]);
    expect(
      body.content.readingUnits.map((unit) => unit.blocks.map((block) => block.blockType))
    ).toEqual([
      ["heading", "paragraph"],
      ["heading", "paragraph"]
    ]);

    const createdAuthors = await context.db.select().from(authors);
    expect(createdAuthors.map((author) => author.name)).toEqual(["司马迁"]);
    expect(body.work.authorId).toBe(createdAuthors[0]?.id);
  });

  it("retains the uploaded .epub on disk with its path and sha256", async () => {
    const bytes = Buffer.from("epub-bytes-provenance");

    const response = await ingestEpub(bytes);
    const body = response.json() as IngestEpubResultDto;

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, body.work.entryId));
    const source = sources[0];
    expect(source?.kind).toBe("upload");
    expect(source?.fileName).toBeNull();
    expect(source?.sourceText).toBeNull();
    expect(source?.filePath).toBe("source-1.epub");

    const onDisk = await readFile(join(context.sourcesDir, "source-1.epub"));
    expect(source?.sha256).toBe(hashBytes(new Uint8Array(bytes)));
    expect(new Uint8Array(onDisk)).toEqual(new Uint8Array(bytes));
  });

  it("matches an existing author by name instead of creating a duplicate", async () => {
    const existingAuthorId = await createAuthorNamed("司马迁");

    const response = await ingestEpub(Buffer.from("epub-match-author"));
    const body = response.json() as IngestEpubResultDto;

    expect(body.work.authorId).toBe(existingAuthorId);
    const allAuthors = await context.db.select().from(authors);
    expect(allAuthors).toHaveLength(1);
  });

  it("is idempotent: re-uploading identical bytes returns the existing work", async () => {
    const bytes = Buffer.from("epub-idempotent");

    const first = await ingestEpub(bytes);
    const firstBody = first.json() as IngestEpubResultDto;

    const second = await ingestEpub(bytes);
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as IngestEpubResultDto;

    expect(secondBody.work.entryId).toBe(firstBody.work.entryId);
    expect(secondBody.content.readingUnits).toHaveLength(2);
    const sources = await context.db.select().from(workSources);
    expect(sources).toHaveLength(1);
  });

  it("creates a work with no reading units for an EPUB without supported blocks", async () => {
    epubResponder = async () => ({
      chapters: [],
      metadata: { author: "Anon", language: "en", title: "Empty" }
    });

    const response = await ingestEpub(Buffer.from("epub-empty"));

    expect(response.statusCode).toBe(201);
    expect((response.json() as IngestEpubResultDto).content.readingUnits).toEqual([]);
  });

  it("returns 422 when the EPUB cannot be parsed", async () => {
    epubResponder = async () => {
      throw new Error("corrupt epub");
    };

    const response = await ingestEpub(Buffer.from("not-an-epub"));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_epub" });
    expect(await context.db.select().from(workSources)).toHaveLength(0);
  });

  it("rejects an empty EPUB body", async () => {
    const response = await ingestEpub(Buffer.alloc(0));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a non-binary body for the EPUB endpoint", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { not: "epub" },
      url: "/api/works/epub"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("creates an untitled reading unit for an EPUB chapter without a heading", async () => {
    epubResponder = async () => ({
      chapters: [{ html: "<p>Just a paragraph, no heading.</p>", images: [] }],
      metadata: { author: "Anon", language: "en", title: "No headings" }
    });

    const response = await ingestEpub(Buffer.from("epub-no-heading"));

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    expect(body.content.readingUnits).toHaveLength(1);
    expect(body.content.readingUnits[0]?.title).toBeUndefined();
    expect(body.content.readingUnits[0]?.blocks.map((block) => block.blockType)).toEqual([
      "paragraph"
    ]);
  });

  it("skips EPUB chapters that decompose to zero supported blocks", async () => {
    epubResponder = async () => ({
      chapters: [
        { html: "<hr>", images: [] },
        { html: "<h1>Real</h1><p>Body.</p>", images: [] }
      ],
      metadata: { author: "Anon", language: "en", title: "Mixed" }
    });

    const response = await ingestEpub(Buffer.from("epub-mixed-empty"));

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    expect(body.content.readingUnits.map((unit) => unit.title)).toEqual(["Real"]);
    expect(body.content.readingUnits[0]?.blocks.map((block) => block.blockType)).toEqual([
      "heading",
      "paragraph"
    ]);
  });

  it("creates a work without a 500 when every chapter lacks supported blocks", async () => {
    epubResponder = async () => ({
      chapters: [
        { html: "<hr>", images: [] },
        { html: "<hr>", images: [] }
      ],
      metadata: { author: "Anon", language: "en", title: "All empty" }
    });

    const response = await ingestEpub(Buffer.from("epub-all-empty"));

    expect(response.statusCode).toBe(201);
    expect((response.json() as IngestEpubResultDto).content.readingUnits).toEqual([]);
    // The .epub is retained (written before the transaction); the empty-block path must
    // not throw and orphan that file.
    expect(await context.db.select().from(workSources)).toHaveLength(1);
  });

  it("accepts an EPUB upload larger than Fastify's default 1 MiB body limit", async () => {
    const largeUpload = Buffer.alloc(2 * 1024 * 1024, 7);

    const response = await ingestEpub(largeUpload);

    expect(response.statusCode).toBe(201);
  });

  it("rejects an EPUB upload that exceeds the configured size limit", async () => {
    epubUploadLimitBytes = 64;
    context = await buildContext();

    const response = await ingestEpub(Buffer.alloc(128, 1));

    expect(response.statusCode).toBe(413);
  });

  it("persists every block of a large EPUB beyond the bind-parameter limit", async () => {
    const chapterCount = 21;
    const paragraphsPerChapter = 250; // 21 × 251 ≈ 5271 blocks × 7 columns ≈ 36900 params
    const chapters = Array.from({ length: chapterCount }, (_, chapterIndex) => {
      const paragraphs = Array.from(
        { length: paragraphsPerChapter },
        (_, paragraphIndex) => `<p>Chapter ${chapterIndex} paragraph ${paragraphIndex}.</p>`
      ).join("");

      return { html: `<h1>Chapter ${chapterIndex}</h1>${paragraphs}`, images: [] };
    });
    epubResponder = async () => ({
      chapters,
      metadata: { author: "Generated", language: "en", title: "Large Book" }
    });
    const expectedBlockCount = chapters.reduce(
      (total, chapter) => total + decomposeHtmlChapter(chapter.html).blocks.length,
      0
    );

    const response = await ingestEpub(Buffer.from("epub-large"));
    expect(response.statusCode).toBe(201);

    const body = response.json() as IngestEpubResultDto;
    const returnedBlockCount = body.content.readingUnits.reduce(
      (total, unit) => total + unit.blocks.length,
      0
    );
    expect(expectedBlockCount).toBeGreaterThan(5000);
    expect(body.content.readingUnits).toHaveLength(chapterCount);
    expect(returnedBlockCount).toBe(expectedBlockCount);
    expect(await context.db.select().from(blocks)).toHaveLength(expectedBlockCount);
  }, 30000);

  it("round-trips a figure block's image, alt, and caption through the content query", async () => {
    const workEntryId = "fig-work";
    const unitEntryId = "fig-unit";
    const blockEntryId = "fig-block";
    const captionMdast = {
      children: [{ type: "text", value: "A river at dusk." }],
      type: "paragraph"
    };

    await context.db.insert(entries).values([
      { id: workEntryId, type: "work" },
      { id: unitEntryId, type: "reading_unit" },
      { id: blockEntryId, type: "block" }
    ]);
    await context.db
      .insert(readingUnits)
      .values({ entryId: unitEntryId, orderIndex: 0, title: "Plate I", workEntryId });
    await context.db.insert(blocks).values({
      alt: "River at dusk",
      blockType: "figure",
      entryId: blockEntryId,
      imageResourceId: "image-123",
      mdastJson: captionMdast,
      orderIndex: 0,
      plaintext: "A river at dusk.",
      readingUnitEntryId: unitEntryId,
      workEntryId
    });

    const content = await loadWorkContent(context.db, toEntryId(workEntryId));

    expect(content.readingUnits).toHaveLength(1);
    expect(content.readingUnits[0].blocks).toEqual([
      {
        alt: "River at dusk",
        blockType: "figure",
        entryId: blockEntryId,
        imageResourceId: "image-123",
        mdast: captionMdast,
        orderIndex: 0,
        plaintext: "A river at dusk."
      }
    ]);
  });

  function pngBytes(): Uint8Array {
    return Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
        "base64"
      )
    );
  }

  function maliciousSvgBytes(): Uint8Array {
    return new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script>' +
        '<image href="https://evil.test/x.png"/><rect width="10" height="10"/></svg>'
    );
  }

  function figureChapter(html: string, images: ReadonlyArray<ParsedEpubImage>): ParsedEpub {
    return {
      chapters: [{ html, images }],
      metadata: { author: "Anon", language: "en", title: "Figures" }
    };
  }

  async function figureBlocksOf(epubLabel: string): Promise<IngestEpubResultDto> {
    const response = await ingestEpub(Buffer.from(epubLabel));
    expect(response.statusCode).toBe(201);

    return response.json() as IngestEpubResultDto;
  }

  it("ingests a <figure> as a figure block with stored image, alt, and caption", async () => {
    const png = pngBytes();
    epubResponder = async () =>
      figureChapter(
        '<h1>Plate</h1><figure><img src="img/p.png" alt="A dot"/><figcaption>The <em>caption</em>.</figcaption></figure>',
        [{ bytes: png, contentType: "image/png", src: "img/p.png" }]
      );

    const body = await figureBlocksOf("epub-figure-png");
    const unit = body.content.readingUnits[0];
    const figure = unit?.blocks.find((block) => block.blockType === "figure");

    expect(figure?.plaintext).toBe("The caption.");
    expect(figure?.alt).toBe("A dot");
    expect(figure?.imageResourceId).toBe(hashBytes(png));
    // The caption is not promoted to a heading or the unit title.
    expect(unit?.title).toBe("Plate");
    expect(
      unit?.blocks.filter((block) => block.blockType === "heading").map((block) => block.plaintext)
    ).toEqual(["Plate"]);
  });

  it("ingests a bare <img> as an image-only figure block (no caption)", async () => {
    const png = pngBytes();
    epubResponder = async () =>
      figureChapter('<p>see</p><img src="img/solo.png" alt=""/>', [
        { bytes: png, contentType: "image/png", src: "img/solo.png" }
      ]);

    const body = await figureBlocksOf("epub-figure-bare");
    const figure = body.content.readingUnits[0]?.blocks.find(
      (block) => block.blockType === "figure"
    );

    expect(figure?.plaintext).toBe("");
    expect(figure?.alt).toBeUndefined();
    expect(figure?.imageResourceId).toBe(hashBytes(png));
  });

  it("ingests a sanitized SVG figure with stored diagram, alt, and caption", async () => {
    epubResponder = async () =>
      figureChapter(
        '<figure><img src="img/d.svg" alt="diagram"/><figcaption>A diagram.</figcaption></figure>',
        [{ bytes: maliciousSvgBytes(), contentType: "image/svg+xml", src: "img/d.svg" }]
      );

    const body = await figureBlocksOf("epub-figure-svg");
    const figure = body.content.readingUnits[0]?.blocks.find(
      (block) => block.blockType === "figure"
    );

    expect(figure?.plaintext).toBe("A diagram.");
    expect(figure?.alt).toBe("diagram");
    expect(figure?.imageResourceId).toBeDefined();
    // The diagram is stored, and the stored SVG is sanitized: no script, event handler, or external ref.
    const stored = new TextDecoder().decode(
      await readFile(join(context.imagesDir, figure?.imageResourceId ?? ""))
    );
    expect(stored).toContain("<rect");
    expect(stored).not.toMatch(/script|onload|evil\.test/iu);
  });

  it("skips a figure with neither a storable image nor a caption", async () => {
    epubResponder = async () => figureChapter('<img src="img/missing.svg"/>', []);

    const body = await figureBlocksOf("epub-figure-empty");

    expect(body.content.readingUnits).toEqual([]);
  });

  it("stores identical figure images once under a shared content-addressed id", async () => {
    const png = pngBytes();
    epubResponder = async () =>
      figureChapter(
        '<figure><img src="img/a.png" alt="one"/><figcaption>A</figcaption></figure>' +
          '<figure><img src="img/b.png" alt="two"/><figcaption>B</figcaption></figure>',
        [
          { bytes: png, contentType: "image/png", src: "img/a.png" },
          { bytes: png, contentType: "image/png", src: "img/b.png" }
        ]
      );

    const body = await figureBlocksOf("epub-figure-dedupe");
    const figures = body.content.readingUnits[0]?.blocks.filter(
      (block) => block.blockType === "figure"
    );
    const id = hashBytes(png);

    expect(figures?.map((figure) => figure.imageResourceId)).toEqual([id, id]);
    // Stored once: the image bytes file plus its `.type` sidecar, and nothing more.
    expect((await readdir(context.imagesDir)).sort()).toEqual([id, `${id}.type`].sort());
  });

  it("degrades a figure whose <img> has no src to a caption-only block", async () => {
    epubResponder = async () =>
      figureChapter("<figure><img alt='x'/><figcaption>Caption only.</figcaption></figure>", []);

    const body = await figureBlocksOf("epub-figure-nosrc");
    const figure = body.content.readingUnits[0]?.blocks.find(
      (block) => block.blockType === "figure"
    );

    expect(figure?.plaintext).toBe("Caption only.");
    expect(figure?.imageResourceId).toBeUndefined();
    expect(await readdir(context.imagesDir)).toEqual([]);
  });

  it("degrades a figure whose image bytes are missing to a caption-only block", async () => {
    epubResponder = async () =>
      figureChapter(
        '<figure><img src="img/gone.png" alt="gone"/><figcaption>Missing bytes.</figcaption></figure>',
        []
      );

    const body = await figureBlocksOf("epub-figure-missing");
    const figure = body.content.readingUnits[0]?.blocks.find(
      (block) => block.blockType === "figure"
    );

    expect(figure?.plaintext).toBe("Missing bytes.");
    expect(figure?.imageResourceId).toBeUndefined();
    expect(await readdir(context.imagesDir)).toEqual([]);
  });

  const structureMarkdown = "Intro.\n\n# Chapter One\n\n- a\n- b\n\n> quote";

  async function getStructure(workEntryId: string): ReturnType<typeof context.server.inject> {
    return context.server.inject({ method: "GET", url: `/api/works/${workEntryId}/structure` });
  }

  it("exposes a work's structure: ordered units with block counts and no content", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: structureMarkdown });

    const response = await getStructure(workEntryId);

    expect(response.statusCode).toBe(200);
    const body = response.json() as WorkStructureDto;
    expect(body.workEntryId).toBe(workEntryId);
    expect(body.readingUnits.map((unit) => [unit.title, unit.orderIndex, unit.blockCount])).toEqual(
      [
        [undefined, 0, 1],
        ["Chapter One", 1, 3]
      ]
    );
    // The structure is content-free: no unit carries a `blocks` array.
    expect(body.readingUnits.every((unit) => !("blocks" in unit))).toBe(true);
  });

  it("returns 404 for the structure of an unknown work", async () => {
    const response = await getStructure("missing-work");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });

  it("returns one reading unit's content on demand", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: structureMarkdown });
    const content = await getContent(workEntryId);
    const chapterUnit = content.readingUnits.find((unit) => unit.title === "Chapter One");

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/units/${chapterUnit?.entryId}/content`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ReadingUnitContentDto;
    expect(body.entryId).toBe(chapterUnit?.entryId);
    expect(body.title).toBe("Chapter One");
    expect(body.orderIndex).toBe(1);
    expect(body.blocks.map((block) => [block.blockType, block.plaintext])).toEqual([
      ["heading", "Chapter One"],
      ["list", "ab"],
      ["blockquote", "quote"]
    ]);

    // The untitled leading unit returns its content with no title.
    const introUnit = content.readingUnits.find((unit) => unit.title === undefined);
    const introResponse = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/units/${introUnit?.entryId}/content`
    });
    const introBody = introResponse.json() as ReadingUnitContentDto;
    expect(introBody.title).toBeUndefined();
    expect(introBody.blocks.map((block) => block.plaintext)).toEqual(["Intro."]);
  });

  it("returns 404 for a unit that is not part of the requested work", async () => {
    const workA = await createWork();
    await ingest(workA, { kind: "manual", markdown: structureMarkdown });
    const unitOfA = (await getContent(workA)).readingUnits[0]?.entryId;
    const workB = await createWork();
    await ingest(workB, { kind: "manual", markdown: structureMarkdown });

    const wrongWork = await context.server.inject({
      method: "GET",
      url: `/api/works/${workB}/units/${unitOfA}/content`
    });
    const unknownUnit = await context.server.inject({
      method: "GET",
      url: `/api/works/${workA}/units/no-such-unit/content`
    });

    expect(wrongWork.statusCode).toBe(404);
    expect(wrongWork.json()).toEqual({ error: "unit_not_found" });
    expect(unknownUnit.statusCode).toBe(404);
  });

  it("locates the reading unit that owns a block", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: structureMarkdown });
    const content = await getContent(workEntryId);
    const chapterUnit = content.readingUnits.find((unit) => unit.title === "Chapter One");
    const quoteBlockId = blockIdByText(content).get("quote");

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/blocks/${quoteBlockId}/unit`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as BlockUnitLocatorDto).unitEntryId).toBe(chapterUnit?.entryId);
  });

  it("returns 404 locating an unknown or soft-deleted block", async () => {
    const workEntryId = await createWork();
    await ingest(workEntryId, { kind: "manual", markdown: structureMarkdown });
    const quoteBlockId = blockIdByText(await getContent(workEntryId)).get("quote");
    // Re-ingest without the blockquote so it is soft-deleted and detached from its unit.
    await ingest(workEntryId, { kind: "manual", markdown: "Intro.\n\n# Chapter One\n\n- a\n- b" });

    const removed = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/blocks/${quoteBlockId}/unit`
    });
    const unknown = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/blocks/no-such-block/unit`
    });

    expect(removed.statusCode).toBe(404);
    expect(removed.json()).toEqual({ error: "block_not_found" });
    expect(unknown.statusCode).toBe(404);
  });
});
