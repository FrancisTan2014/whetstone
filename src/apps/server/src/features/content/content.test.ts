import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  epubContentType,
  pdfContentType,
  type BlockUnitLocatorDto,
  type IngestEpubResultDto,
  type ReadingUnitContentDto,
  type WorkAnchorIndexDto,
  type WorkContentDto,
  type WorkStructureDto
} from "@whetstone/contracts";
import { decomposeHtmlChapter, decomposeMarkdown, toEntryId } from "@whetstone/domain";
import { isValidDocument, parseDocument, type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  docBlocks,
  entries,
  readingPositions,
  readingUnits,
  tocEntries,
  workSources
} from "../../db/schema.js";
import { writeReadingUnits } from "./blockWriter.js";
import { loadWorkContent } from "./contentQueries.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore, hashBytes, hashMarkdown } from "../../files/sourceFileStore.js";
import type { ParsedEpub, ParsedEpubImage } from "../../files/epubSource.js";
import { createServer } from "../../http/createServer.js";
import type { ContentDependencies } from "./contentCommands.js";
import type { IngestionEvidence } from "./htmlToDocument.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";

type TestContext = Readonly<{
  db: DbClient;
  imagesDir: string;
  pglite: PGlite;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
}>;

// A minimal view of a persisted PM node's JSON, for asserting the decomposed doc_blocks rows.
type PmNode = Readonly<{
  attrs?: Record<string, unknown>;
  content?: ReadonlyArray<PmNode>;
  marks?: ReadonlyArray<Record<string, unknown>>;
  type: string;
}>;

let context: TestContext;
let epubResponder: (bytes: Uint8Array) => Promise<ParsedEpub>;
let pdfResponder: () => Promise<string>;
let epubUploadLimitBytes: number;
let loggedEvidence: IngestionEvidence[];

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
    ingestionLogger: (records) => loggedEvidence.push(...records),
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
  loggedEvidence = [];
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

  it("retains the uploaded PDF source with a .pdf path and the PDF byte hash, not Markdown", async () => {
    pdfResponder = async () => "Intro.\n\n# Chapter\n\n- a";
    const workEntryId = await createWork();
    const pdfBytes = Buffer.from("%PDF-1.7 original bytes");

    expect((await ingestPdf(workEntryId, pdfBytes)).statusCode).toBe(201);

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    const source = sources[0];
    expect(source?.kind).toBe("upload");
    expect(source?.fileName).toBe("upload.pdf");
    expect(source?.filePath?.endsWith(".pdf")).toBe(true);
    expect(source?.sourceText).toBeNull();
    // Provenance hashes the original PDF payload, not the converted Markdown.
    expect(source?.sha256).toBe(hashBytes(new Uint8Array(pdfBytes)));
    expect(source?.sha256).not.toBe(hashMarkdown("Intro.\n\n# Chapter\n\n- a"));
  });

  it("re-uploading an equivalent PDF is a no-op that leaves one source and no orphan file", async () => {
    pdfResponder = async () => "Intro.\n\n# Chapter\n\n- a";
    const workEntryId = await createWork();

    expect((await ingestPdf(workEntryId, Buffer.from("%PDF first"))).statusCode).toBe(201);
    // A different PDF payload converting to the same Markdown re-ingests to identical blocks: a no-op.
    expect((await ingestPdf(workEntryId, Buffer.from("%PDF second"))).statusCode).toBe(201);

    const sources = await context.db
      .select()
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));
    expect(sources).toHaveLength(1);
    expect(
      (await readdir(context.sourcesDir)).filter((name) => name.endsWith(".pdf"))
    ).toHaveLength(1);
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
    // No work_sources row would exist, so no PDF file may be orphaned on disk.
    expect((await readdir(context.sourcesDir)).filter((name) => name.endsWith(".pdf"))).toEqual([]);
  });

  it("returns 404 ingesting a PDF into a missing work", async () => {
    expect((await ingestPdf("missing-work", Buffer.from("%PDF"))).statusCode).toBe(404);
    expect((await readdir(context.sourcesDir)).filter((name) => name.endsWith(".pdf"))).toEqual([]);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await ingestEpub(Buffer.from("not-an-epub"));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_epub" });
    expect(await context.db.select().from(workSources)).toHaveLength(0);
    // The failure is logged (not swallowed) with the reason and the content hash of the bytes.
    expect(warn).toHaveBeenCalledWith(
      "[ingestion] EPUB could not be parsed",
      expect.stringContaining("corrupt epub")
    );
    warn.mockRestore();
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

  it("trims publisher boilerplate units at ingest, leaving the actual work intact (#275)", async () => {
    epubResponder = async () => ({
      chapters: [
        { html: "<h1>关于我们</h1><p>本书由 7sbook 制作。</p>", images: [] },
        { html: "<h1>世说新语·德行</h1><p>陈仲举言为士则。</p>", images: [] },
        { html: "<h1>制作说明</h1><p>排版与校对说明。</p>", images: [] },
        { html: "<h1>世说新语·言语</h1><p>边文礼见袁奉高。</p>", images: [] }
      ],
      metadata: { author: "刘义庆", language: "zh-CN", title: "世说新语" }
    });

    const response = await ingestEpub(Buffer.from("epub-7sbook-boilerplate"));

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    // The 关于我们 / 制作说明 publisher pages are gone; both real chapters remain, in order.
    expect(body.content.readingUnits.map((unit) => [unit.title, unit.orderIndex])).toEqual([
      ["世说新语·德行", 0],
      ["世说新语·言语", 1]
    ]);
  });

  it("persists an unknown-only chapter's PM node in doc_blocks while keeping it out of the mdast reader", async () => {
    epubResponder = async () => ({
      chapters: [
        { html: "<canvas></canvas>", images: [] },
        { html: "<h1>Real</h1><p>Body.</p>", images: [] }
      ],
      metadata: { author: "Anon", language: "en", title: "Mixed" }
    });

    const response = await ingestEpub(Buffer.from("epub-mixed-empty"));

    expect(response.statusCode).toBe(201);
    const body = response.json() as IngestEpubResultDto;
    // The mdast reader is unchanged: the <canvas> chapter has no renderable mdast block, so only the
    // real chapter is returned, in order.
    expect(body.content.readingUnits.map((unit) => unit.title)).toEqual(["Real"]);
    expect(body.content.readingUnits[0]?.blocks.map((block) => block.blockType)).toEqual([
      "heading",
      "paragraph"
    ]);

    // The structure view mirrors the content view: the empty-mdast <canvas> unit is excluded, leaving
    // only the real chapter with its block count.
    const structure = await getStructure(body.content.workEntryId);
    expect((structure.json() as WorkStructureDto).readingUnits.map((unit) => unit.title)).toEqual([
      "Real"
    ]);

    // Fail-loud (#311): the unknown block-level <canvas> still persists as an `unknown` PM block row,
    // not silently dropped.
    const unknownRows = (await context.db.select().from(docBlocks)).filter(
      (row) => row.type === "unknown"
    );
    expect(unknownRows).toHaveLength(1);
    const unknownRow = unknownRows[0];
    expect((unknownRow?.nodeJson as PmNode).attrs?.["id"]).toBe(unknownRow?.id);
    expect(String((unknownRow?.nodeJson as PmNode).attrs?.["html"])).toContain("<canvas");

    // ...and its evidence reached the injected fail-loud sink.
    expect(loggedEvidence.some((record) => record.tag === "canvas")).toBe(true);
  });

  it("persists every chapter's unknown PM node when all chapters lack supported blocks (no 500)", async () => {
    epubResponder = async () => ({
      chapters: [
        { html: "<canvas></canvas>", images: [] },
        { html: "<canvas></canvas>", images: [] }
      ],
      metadata: { author: "Anon", language: "en", title: "All empty" }
    });

    const response = await ingestEpub(Buffer.from("epub-all-empty"));

    expect(response.statusCode).toBe(201);
    // The mdast reader shows no units (both chapters are unknown-only), but the work exists and the
    // .epub is retained (written before the transaction); the empty-mdast path must not throw and
    // orphan that file.
    expect((response.json() as IngestEpubResultDto).content.readingUnits).toEqual([]);
    expect(await context.db.select().from(workSources)).toHaveLength(1);

    // Fail-loud (#311): both <canvas> chapters persist their `unknown` PM nodes, and both logged evidence.
    const unknownRows = (await context.db.select().from(docBlocks)).filter(
      (row) => row.type === "unknown"
    );
    expect(unknownRows).toHaveLength(2);
    expect(loggedEvidence.filter((record) => record.tag === "canvas")).toHaveLength(2);
  });

  it("persists a <video> chapter's unknown PM node alongside its mdast block, never dropping it (#311 fail-loud)", async () => {
    epubResponder = async () => figureChapter('<video src="clip.mp4"></video>', []);

    const response = await ingestEpub(Buffer.from("epub-video-only"));

    expect(response.statusCode).toBe(201);
    // The mdast decomposer turns a bare <video> into an empty paragraph block, so this chapter is NOT
    // mdast-empty: the reader still shows its one (empty) unit, unaffected by the fidelity path. (The
    // genuinely PM-only retention path — an mdast-empty chapter kept solely for its PM nodes — is
    // covered by the <hr>-only tests above.)
    const content = (response.json() as IngestEpubResultDto).content;
    expect(content.readingUnits).toHaveLength(1);
    expect(content.readingUnits[0]?.blocks.map((block) => block.blockType)).toEqual(["paragraph"]);

    // ...and the <video> is NOT dropped: it persists as a single `unknown` PM block row whose stable
    // id is its node id, with the original markup kept verbatim.
    const rows = await context.db.select().from(docBlocks);
    expect(rows.map((row) => row.type)).toEqual(["unknown"]);
    const row = rows[0];
    expect((row?.nodeJson as PmNode).attrs?.["id"]).toBe(row?.id);
    expect(String((row?.nodeJson as PmNode).attrs?.["html"])).toContain("<video");

    // ...and its evidence reached the injected fail-loud sink.
    expect(loggedEvidence.some((record) => record.tag === "video")).toBe(true);
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
    // Stress test: ~7s in isolation but highly sensitive to parallel-suite CPU contention — every
    // EPUB chapter now also runs jsdom-based htmlToDocument for the #311 dual-write, and this may run
    // on a shared machine, so it carries a generous wall-clock timeout rather than the default.
  }, 120000);

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

  it("preserves a host element id as a block anchor for in-work cross-references (#252)", async () => {
    epubResponder = async () =>
      figureChapter('<p id="sec-3">A referenced paragraph.</p><p>Plain.</p>', []);

    const body = await figureBlocksOf("epub-anchor");
    const blocks = body.content.readingUnits[0]?.blocks ?? [];
    expect(blocks.find((block) => block.plaintext === "A referenced paragraph.")?.anchorId).toBe(
      "sec-3"
    );
    expect(blocks.find((block) => block.plaintext === "Plain.")?.anchorId).toBeUndefined();
  });

  it("persists and serves a footnote pair's two-way anchors (#250)", async () => {
    epubResponder = async () =>
      figureChapter(
        '<p>Replication keeps a copy<sup><a epub:type="noteref" href="#fn-i" id="ref-i">i</a></sup>.</p>' +
          '<aside epub:type="footnote" id="fn-i"><p>There are other reasons too.</p></aside>',
        []
      );

    const body = await figureBlocksOf("epub-footnote");
    const blocks = body.content.readingUnits[0]?.blocks ?? [];
    const marker = blocks.find((block) => block.plaintext.startsWith("Replication"));
    const note = blocks.find((block) => block.plaintext.startsWith("There are other"));

    // The marker block is addressable by the marker id; the note carries a back-link to it.
    expect(marker?.anchorId).toBe("ref-i");
    expect(marker?.backlinkAnchorId).toBeUndefined();
    expect(note?.anchorId).toBe("fn-i");
    expect(note?.backlinkAnchorId).toBe("ref-i");
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

  it("dual-writes decomposed PM block rows carrying stable ids and the real flow's evidence (#311)", async () => {
    const png = pngBytes();
    epubResponder = async () =>
      figureChapter(
        '<figure><img src="img/p.png" alt="A dot"/><figcaption>A caption.</figcaption></figure>' +
          "<dl><dt>Term</dt><dd>Definition.</dd></dl>" +
          '<div data-type="note"><p>An admonition.</p></div>' +
          '<p>Some claim<a data-type="noteref" href="#fn1">1</a>.</p>' +
          '<aside data-type="footnote" id="fn1"><p>The note body.</p></aside>' +
          '<video src="clip.mp4"></video>',
        [{ bytes: png, contentType: "image/png", src: "img/p.png" }]
      );

    await figureBlocksOf("epub-pm-docblocks");

    // The legacy mdast block rows still persist for the current reader (retired in #312).
    expect((await context.db.select().from(blocks)).length).toBeGreaterThan(0);

    // The chapter's PM nodes are dual-written at the block-row boundary, one row per top-level node.
    const rows = (await context.db.select().from(docBlocks)).sort(
      (a, b) => a.orderIndex - b.orderIndex
    );
    const byType = (type: string): PmNode | undefined =>
      rows.find((row) => row.type === type)?.nodeJson as PmNode | undefined;

    // Every recognized and unknown block type is present as its own row.
    expect(rows.map((row) => row.type)).toEqual(
      expect.arrayContaining([
        "figure",
        "definitionList",
        "callout",
        "paragraph",
        "footnoteTarget",
        "unknown"
      ])
    );

    // Each row's id is a non-empty string equal to its node's stable attrs.id (PM id -> row mapping).
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(row.id.length).toBeGreaterThan(0);
      expect((row.nodeJson as PmNode).attrs?.["id"]).toBe(row.id);
    }

    // The figure node keeps its image child and the resolved src, now stamped with the stored-image
    // reference (#312) so the read-only reader can serve it from the image store.
    const figureImage = byType("figure")?.content?.find((child) => child.type === "image");
    expect(figureImage?.attrs?.["src"]).toBe("img/p.png");
    expect(figureImage?.attrs?.["imageResourceId"]).toBe(hashBytes(png));

    // The definition list keeps its term/description children (not flattened into empty bullets).
    expect(byType("definitionList")?.content?.map((child) => child.type)).toEqual([
      "definitionTerm",
      "definitionDescription"
    ]);

    // The callout carries its kind, and the footnote target its refId.
    expect(byType("callout")?.attrs?.["kind"]).toBe("note");
    expect(byType("footnoteTarget")?.attrs?.["refId"]).toBe("fn1");

    // The unknown node preserves the original markup verbatim, fail-loud rather than dropped.
    expect(String(byType("unknown")?.attrs?.["html"])).toContain("<video");

    // The paragraph that hosted the noteref carries a footnoteMarker inline node referencing fn1.
    const marker = byType("paragraph")?.content?.find((child) => child.type === "footnoteMarker");
    expect(marker?.attrs?.["refId"]).toBe("fn1");
    expect(marker?.attrs?.["label"]).toBe("1");

    // The reassembled document round-trips through the pure package, proving the nodes are valid.
    const reassembled = {
      content: rows.map((row) => row.nodeJson),
      type: "doc"
    } as DocumentNodeJSON;
    expect(isValidDocument(reassembled)).toBe(true);
    expect(() => parseDocument(reassembled)).not.toThrow();

    // The injected fail-loud sink received the <video> evidence, proving the path runs end to end.
    const videoEvidence = loggedEvidence.find((record) => record.tag === "video");
    expect(videoEvidence?.attributes["src"]).toBe("clip.mp4");
  });

  it("serves a reading unit's PM doc blocks on demand (#312), including a figure image's stored reference", async () => {
    const png = pngBytes();
    epubResponder = async () =>
      figureChapter(
        '<h1>Plate</h1><figure><img src="img/p.png" alt="A dot"/><figcaption>The caption.</figcaption></figure>',
        [{ bytes: png, contentType: "image/png", src: "img/p.png" }]
      );

    const body = await figureBlocksOf("epub-pm-unit-content");
    const unit = body.content.readingUnits[0];

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${body.content.workEntryId}/units/${unit?.entryId}/content`
    });

    expect(response.statusCode).toBe(200);
    const served = response.json() as ReadingUnitContentDto;

    // The mdast blocks still travel (search/legacy), additive to the PM doc blocks the reader renders.
    expect(served.blocks.length).toBeGreaterThan(0);

    // The PM doc blocks are served in reading order, each row's entryId equal to its node's stable id.
    expect(served.docBlocks.map((block) => block.type)).toEqual(["heading", "figure"]);
    for (const docBlock of served.docBlocks) {
      expect((docBlock.node as PmNode).attrs?.["id"]).toBe(docBlock.entryId);
    }

    // The figure's image node carries the stored-image reference the read-only reader serves (#312).
    const figureNode = served.docBlocks.find((block) => block.type === "figure")?.node as
      | PmNode
      | undefined;
    const image = figureNode?.content?.find((child) => child.type === "image");
    expect(image?.attrs?.["imageResourceId"]).toBe(hashBytes(png));
  });

  it("writes no doc_blocks rows for a reading unit with no PM blocks", async () => {
    const workEntryId = await createWork();
    let nextId = 0;
    await context.db.transaction(async (tx) => {
      await writeReadingUnits(tx, {
        createEntryId: () => `no-doc-${(nextId += 1)}`,
        startOrder: 0,
        units: [
          {
            blocks: [
              {
                alt: null,
                anchorId: null,
                backlinkAnchorId: null,
                blockType: "paragraph",
                imageResourceId: null,
                mdast: { type: "paragraph" },
                plaintext: "Mdast only, no PM blocks."
              }
            ],
            docBlocks: [],
            evidence: [],
            title: "Mdast only"
          }
        ],
        workEntryId: toEntryId(workEntryId)
      });
    });

    // The mdast block row persists, but the empty docBlocks path writes nothing to doc_blocks.
    expect(await context.db.select().from(docBlocks)).toEqual([]);
    expect(
      (await context.db.select().from(blocks)).some(
        (row) => row.plaintext === "Mdast only, no PM blocks."
      )
    ).toBe(true);
  });

  it("writes nothing when a reading unit has neither mdast blocks nor PM blocks", async () => {
    // Covers the fail-loud filter's both-empty path: a unit with no mdast blocks AND no PM docBlocks
    // is dropped entirely, so writeReadingUnits early-returns without creating a reading_units row.
    const workEntryId = await createWork();
    await context.db.transaction(async (tx) => {
      await writeReadingUnits(tx, {
        createEntryId: () => "should-not-be-used",
        startOrder: 0,
        units: [{ blocks: [], docBlocks: [], evidence: [], sourceFile: null, title: "Empty" }],
        workEntryId: toEntryId(workEntryId)
      });
    });

    expect(await context.db.select().from(readingUnits)).toEqual([]);
    expect(await context.db.select().from(docBlocks)).toEqual([]);
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

    // A Markdown work has no PM `doc_blocks` yet (the Markdown -> PM ingestion is a later slice), so
    // the additive PM block list is empty; the reader falls back to its mdast blocks for such units.
    expect(introBody.docBlocks).toEqual([]);
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

describe("work-scoped reference foundation (#366)", () => {
  // A two-chapter EPUB whose chapters live in different source files, reuse the SAME anchor id
  // ("shared") in each file, and carry a cross-file endnote marker pointing from ch01 into the notes
  // file — the fixture that exercises per-file identity, addressable anchors, and endnote targeting.
  function refsEpub(): ParsedEpub {
    return {
      chapters: [
        {
          html:
            "<h1>Chapter One</h1>" +
            '<p id="shared">Chapter one anchor.</p>' +
            '<p>See the note<a data-type="noteref" href="notes.xhtml#note1">1</a>.</p>' +
            // An inert marker with no resolvable target (no `#`, no `data-target`): it stays unstamped.
            '<p>No target<a data-type="noteref" href="endnotes.html">x</a>.</p>' +
            // Reference links (#368): a cross-file xref, a same-file `#id` link, and an external link.
            '<p>Read <a data-type="xref" href="notes.xhtml#note1">the notes</a>, ' +
            '<a href="#shared">this anchor</a>, or ' +
            '<a href="https://example.com">the web</a>.</p>',
          images: [],
          sourceFile: "text/ch01.xhtml"
        },
        {
          html:
            "<h1>Notes</h1>" +
            '<p id="shared">Notes anchor.</p>' +
            '<aside data-type="footnote" id="note1"><p>The endnote body.</p></aside>',
          images: [],
          sourceFile: "text/notes.xhtml"
        }
      ],
      metadata: { author: "Anon", language: "en", title: "Refs" }
    };
  }

  function findNode(node: PmNode, type: string): PmNode | undefined {
    if (node.type === type) {
      return node;
    }
    for (const child of node.content ?? []) {
      const found = findNode(child, type);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  async function ingestRefs(): Promise<string> {
    epubResponder = async () => refsEpub();
    const response = await ingestEpub(Buffer.from("epub-refs"));
    expect(response.statusCode).toBe(201);

    return (response.json() as IngestEpubResultDto).work.entryId;
  }

  it("persists each reading unit's source file from the EPUB spine", async () => {
    const workEntryId = await ingestRefs();

    const units = await context.db
      .select()
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(readingUnits.orderIndex);

    expect(units.map((unit) => unit.sourceFile)).toEqual(["text/ch01.xhtml", "text/notes.xhtml"]);
  });

  it("surfaces each unit's source file through the work structure and unit content", async () => {
    const workEntryId = await ingestRefs();

    const structureResponse = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/structure`
    });
    const structure = structureResponse.json() as WorkStructureDto;
    expect(structure.readingUnits.map((unit) => unit.sourceFile)).toEqual([
      "text/ch01.xhtml",
      "text/notes.xhtml"
    ]);

    const firstUnit = structure.readingUnits[0]!;
    const contentResponse = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/units/${firstUnit.entryId}/content`
    });
    expect((contentResponse.json() as ReadingUnitContentDto).sourceFile).toBe("text/ch01.xhtml");
  });

  it("captures a block's source-HTML id as doc_blocks.anchor_id without leaking it into node JSON", async () => {
    const workEntryId = await ingestRefs();

    const rows = await context.db
      .select()
      .from(docBlocks)
      .where(eq(docBlocks.workEntryId, workEntryId));

    const shared = rows.filter((row) => row.anchorId === "shared");
    expect(shared).toHaveLength(2);
    // A heading without an id yields no anchor id, so it is not addressable.
    expect(rows.some((row) => row.type === "heading" && row.anchorId !== null)).toBe(false);
    // The addressing id lives in the column only — never in the stored render content.
    for (const row of rows) {
      expect(JSON.stringify(row.nodeJson)).not.toContain("anchorId");
    }
  });

  it("indexes work anchors per source file so a reused anchor id does not collide across chapters", async () => {
    const workEntryId = await ingestRefs();

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/anchors`
    });

    expect(response.statusCode).toBe(200);
    const index = response.json() as WorkAnchorIndexDto;
    expect(index.workEntryId).toBe(workEntryId);

    const shared = index.anchors.filter((entry) => entry.anchor === "shared");
    expect(shared.map((entry) => entry.sourceFile).sort()).toEqual([
      "text/ch01.xhtml",
      "text/notes.xhtml"
    ]);
    // The two same-id anchors resolve to distinct blocks in distinct reading units — no collision.
    expect(new Set(shared.map((entry) => entry.blockEntryId)).size).toBe(2);
    expect(new Set(shared.map((entry) => entry.unitEntryId)).size).toBe(2);

    // The endnote target in the notes file is addressable by its own id.
    expect(
      index.anchors.some(
        (entry) => entry.anchor === "note1" && entry.sourceFile === "text/notes.xhtml"
      )
    ).toBe(true);
  });

  it("stamps a cross-file endnote marker with the resolved target source file", async () => {
    const workEntryId = await ingestRefs();

    const rows = await context.db
      .select()
      .from(docBlocks)
      .where(eq(docBlocks.workEntryId, workEntryId));

    const markers = rows
      .map((row) => findNode(row.nodeJson as PmNode, "footnoteMarker"))
      .filter((node): node is PmNode => node !== undefined);

    const resolved = markers.find((marker) => marker.attrs?.["refId"] === "note1");
    expect(resolved?.attrs).toMatchObject({
      refFile: "notes.xhtml",
      refId: "note1",
      targetSourceFile: "text/notes.xhtml"
    });

    // The inert marker (no resolvable target) is left unstamped: its `targetSourceFile` stays null.
    const inert = markers.find((marker) => marker.attrs?.["refId"] === null);
    expect(inert?.attrs?.["targetSourceFile"] ?? null).toBeNull();
  });

  it("stamps same-work link marks with the resolved target source file, leaving external links inert (#368)", async () => {
    const workEntryId = await ingestRefs();

    const rows = await context.db
      .select()
      .from(docBlocks)
      .where(eq(docBlocks.workEntryId, workEntryId));

    // Link marks live in a text node's `marks` array, so gather them by walking marks (not node attrs).
    const linkAttrs: Array<Record<string, unknown>> = [];
    const collect = (node: PmNode): void => {
      for (const mark of (node.marks as Array<Record<string, unknown>> | undefined) ?? []) {
        if (mark["type"] === "link") {
          linkAttrs.push(mark["attrs"] as Record<string, unknown>);
        }
      }
      for (const child of node.content ?? []) {
        collect(child);
      }
    };
    for (const row of rows) {
      collect(row.nodeJson as PmNode);
    }

    // The cross-file xref resolves its file part against ch01 -> the notes unit's source file.
    const xref = linkAttrs.find((attrs) => attrs["kind"] === "xref");
    expect(xref).toMatchObject({
      anchor: "note1",
      inert: false,
      refFile: "notes.xhtml",
      targetSourceFile: "text/notes.xhtml"
    });

    // The same-file `#shared` link has no file part, so it resolves to ch01's own source file.
    const sameFile = linkAttrs.find((attrs) => attrs["anchor"] === "shared");
    expect(sameFile).toMatchObject({
      inert: false,
      refFile: null,
      targetSourceFile: "text/ch01.xhtml"
    });

    // The external link stays inert with no resolved target — it never navigates within the work.
    const external = linkAttrs.find((attrs) => attrs["inert"] === true);
    expect(external?.["targetSourceFile"] ?? null).toBeNull();
  });

  it("returns 404 for the anchors of an unknown work", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/works/missing-work/anchors"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "work_not_found" });
  });
});

describe("nav-derived table of contents (#379)", () => {
  // An EPUB3 authored nav (nav.xhtml) whose entries exercise every target shape: a label-only
  // structural node (empty href), a whole-file entry, a same-file `#fragment`, a `../` relative href,
  // and an entry pointing at a file with no reading unit (unresolvable). `path` is the nav document's
  // own manifest href, the base each entry href resolves against (#366).
  const navSource =
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
    '<nav epub:type="toc"><ol>' +
    '<li><a href="">Part One</a><ol>' +
    '<li><a href="ch01.xhtml">Chapter One</a>' +
    '<ol><li><a href="ch01.xhtml#sec-1">Section 1.1</a></li></ol></li>' +
    "</ol></li>" +
    '<li><a href="../text/ch02.xhtml">Chapter Two</a></li>' +
    '<li><a href="ghost.xhtml">Missing</a></li>' +
    "</ol></nav></body></html>";

  function navEpub(): ParsedEpub {
    return {
      chapters: [
        {
          html: '<h1>Chapter One</h1><p id="sec-1">First section.</p>',
          images: [],
          sourceFile: "text/ch01.xhtml"
        },
        { html: "<h1>Chapter Two</h1><p>Second.</p>", images: [], sourceFile: "text/ch02.xhtml" }
      ],
      metadata: { author: "Anon", language: "en", title: "Nav Book" },
      nav: { kind: "xhtml-nav", path: "text/nav.xhtml", source: navSource }
    };
  }

  async function ingestNav(): Promise<string> {
    epubResponder = async () => navEpub();
    const response = await ingestEpub(Buffer.from("epub-nav"));
    expect(response.statusCode).toBe(201);

    return (response.json() as IngestEpubResultDto).work.entryId;
  }

  it("persists the authored nav tree as toc_entries with depth, order, parent, and targets", async () => {
    const workEntryId = await ingestNav();

    const rows = await context.db
      .select()
      .from(tocEntries)
      .where(eq(tocEntries.workEntryId, workEntryId))
      .orderBy(tocEntries.orderIndex);

    const byLabel = new Map(rows.map((row) => [row.label, row]));
    const row = (label: string): (typeof rows)[number] => {
      const found = byLabel.get(label);
      if (found === undefined) {
        throw new Error(`no toc_entries row for ${label}`);
      }
      return found;
    };

    // Pre-order flattening with a work-global orderIndex, so serving in this order renders the tree
    // fully expanded and correctly indented by depth.
    expect(rows.map((entry) => entry.label)).toEqual([
      "Part One",
      "Chapter One",
      "Section 1.1",
      "Chapter Two",
      "Missing"
    ]);
    expect(rows.map((entry) => entry.orderIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((entry) => entry.depth)).toEqual([0, 1, 2, 0, 0]);

    // Hierarchy is captured by parentEntryId (null at the roots).
    expect(row("Part One").parentEntryId).toBeNull();
    expect(row("Chapter One").parentEntryId).toBe(row("Part One").entryId);
    expect(row("Section 1.1").parentEntryId).toBe(row("Chapter One").entryId);
    expect(row("Chapter Two").parentEntryId).toBeNull();

    // Targets: a structural node stays unresolved; a whole-file entry has no anchor; a `#fragment`
    // splits into source file + anchor; a `../` href resolves against the nav document's directory.
    expect(row("Part One")).toMatchObject({ targetAnchor: null, targetSourceFile: null });
    expect(row("Chapter One")).toMatchObject({
      targetAnchor: null,
      targetSourceFile: "text/ch01.xhtml"
    });
    expect(row("Section 1.1")).toMatchObject({
      targetAnchor: "sec-1",
      targetSourceFile: "text/ch01.xhtml"
    });
    expect(row("Chapter Two")).toMatchObject({
      targetAnchor: null,
      targetSourceFile: "text/ch02.xhtml"
    });
  });

  it("registers each toc entry as an addressable entries row of type toc_entry", async () => {
    const workEntryId = await ingestNav();

    const tocRows = await context.db
      .select()
      .from(tocEntries)
      .where(eq(tocEntries.workEntryId, workEntryId));

    for (const tocRow of tocRows) {
      const entryRows = await context.db
        .select()
        .from(entries)
        .where(eq(entries.id, tocRow.entryId));
      expect(entryRows[0]?.type).toBe("toc_entry");
    }
  });

  it("serves the tableOfContents additively with targetUnitEntryId resolved from source_file", async () => {
    const workEntryId = await ingestNav();

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/structure`
    });
    const structure = response.json() as WorkStructureDto;

    // The reading-unit list is unchanged by the additive TOC.
    expect(structure.readingUnits.map((unit) => unit.sourceFile)).toEqual([
      "text/ch01.xhtml",
      "text/ch02.xhtml"
    ]);
    const unitBySource = new Map(
      structure.readingUnits.map((unit) => [unit.sourceFile, unit.entryId])
    );

    const toc = structure.tableOfContents ?? [];
    const entryByLabel = new Map(toc.map((entry) => [entry.label, entry]));
    const tocEntry = (label: string): NonNullable<WorkStructureDto["tableOfContents"]>[number] => {
      const found = entryByLabel.get(label);
      if (found === undefined) {
        throw new Error(`no toc entry for ${label}`);
      }
      return found;
    };

    expect(toc.map((entry) => entry.label)).toEqual([
      "Part One",
      "Chapter One",
      "Section 1.1",
      "Chapter Two",
      "Missing"
    ]);

    // A whole-file entry resolves to its unit with no anchor; a `#fragment` carries the anchor through.
    expect(tocEntry("Chapter One").targetUnitEntryId).toBe(unitBySource.get("text/ch01.xhtml"));
    expect(tocEntry("Chapter One").targetAnchor).toBeUndefined();
    expect(tocEntry("Section 1.1")).toMatchObject({
      targetAnchor: "sec-1",
      targetUnitEntryId: unitBySource.get("text/ch01.xhtml")
    });
    expect(tocEntry("Chapter Two").targetUnitEntryId).toBe(unitBySource.get("text/ch02.xhtml"));

    // A structural node and an entry whose file has no reading unit both leave targetUnitEntryId unset.
    expect(tocEntry("Part One").targetUnitEntryId).toBeUndefined();
    expect(tocEntry("Missing").targetUnitEntryId).toBeUndefined();

    // Depth is served as data so the reader can indent without re-deriving the tree.
    expect(toc.map((entry) => entry.depth)).toEqual([0, 1, 2, 0, 0]);
  });

  it("omits tableOfContents and leaves readingUnits unchanged for a nav-less work", async () => {
    epubResponder = async () => refsEpubNoNav();
    const ingestResponse = await ingestEpub(Buffer.from("epub-no-nav"));
    expect(ingestResponse.statusCode).toBe(201);
    const workEntryId = (ingestResponse.json() as IngestEpubResultDto).work.entryId;

    const tocRows = await context.db
      .select()
      .from(tocEntries)
      .where(eq(tocEntries.workEntryId, workEntryId));
    expect(tocRows).toEqual([]);

    const response = await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/structure`
    });
    const structure = response.json() as WorkStructureDto;

    expect(structure.tableOfContents).toBeUndefined();
    expect(structure.readingUnits.map((unit) => unit.sourceFile)).toEqual([
      "text/ch01.xhtml",
      "text/ch02.xhtml"
    ]);
  });
});

// A nav-less two-chapter EPUB, to prove ingestion persists no toc_entries and the structure omits the
// TOC when the parser surfaces no nav (#379).
function refsEpubNoNav(): ParsedEpub {
  return {
    chapters: [
      { html: "<h1>Chapter One</h1><p>First.</p>", images: [], sourceFile: "text/ch01.xhtml" },
      { html: "<h1>Chapter Two</h1><p>Second.</p>", images: [], sourceFile: "text/ch02.xhtml" }
    ],
    metadata: { author: "Anon", language: "en", title: "No Nav" }
  };
}
