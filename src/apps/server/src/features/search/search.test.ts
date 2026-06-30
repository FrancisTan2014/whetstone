import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { epubContentType } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, blocks, docBlocks, entries, readingUnits, workMeta } from "../../db/schema.js";
import { createImageResourceStore } from "../../files/imageResourceStore.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import type { ParsedEpub } from "../../files/epubSource.js";
import { createServer } from "../../http/createServer.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import { escapeLikePattern, searchBlocks } from "./searchQueries.js";

let db: DbClient;
let server: ReturnType<typeof createServer>;

const paragraph = { type: "paragraph" } as const;

// Two English works (Animal Farm < Fables by title) plus a Chinese work exercise ordering, the
// case-insensitive match, CJK substring matching, the soft-deleted/detached exclusions, and the
// LIKE-wildcard escaping. Block ids are ordered b-1..b-7 so result order is unambiguous.
async function seed(database: DbClient): Promise<void> {
  await database.insert(entries).values([
    { id: "work-1", type: "work" },
    { id: "work-2", type: "work" },
    { id: "work-3", type: "work" },
    { id: "unit-1", type: "reading_unit" },
    { id: "unit-1b", type: "reading_unit" },
    { id: "unit-2", type: "reading_unit" },
    { id: "unit-3", type: "reading_unit" },
    { id: "b-1", type: "block" },
    { id: "b-2", type: "block" },
    { id: "b-3", type: "block" },
    { id: "b-4", type: "block" },
    { id: "b-5", type: "block" },
    { id: "b-6", type: "block" },
    { id: "b-7", type: "block" },
    { id: "b-8", type: "block" }
  ]);

  await database.insert(authors).values([
    { id: "author-1", name: "George Orwell" },
    { id: "author-2", name: "Aesop" },
    { id: "author-3", name: "佚名" }
  ]);

  await database.insert(workMeta).values([
    {
      authorId: "author-1",
      entryId: "work-1",
      language: "en",
      title: "Animal Farm",
      workType: "book"
    },
    { authorId: "author-2", entryId: "work-2", language: "en", title: "Fables", workType: "book" },
    {
      authorId: "author-3",
      entryId: "work-3",
      language: "zh-CN",
      title: "寓言",
      workType: "classical_text"
    }
  ]);

  await database.insert(readingUnits).values([
    { entryId: "unit-1", orderIndex: 0, title: "Chapter 1", workEntryId: "work-1" },
    { entryId: "unit-1b", orderIndex: 1, title: "Chapter 2", workEntryId: "work-1" },
    { entryId: "unit-2", orderIndex: 0, title: null, workEntryId: "work-2" },
    { entryId: "unit-3", orderIndex: 0, title: null, workEntryId: "work-3" }
  ]);

  await database.insert(blocks).values([
    {
      blockType: "paragraph",
      entryId: "b-1",
      mdastJson: paragraph,
      orderIndex: 0,
      plaintext: "The dog barked loudly.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-2",
      mdastJson: paragraph,
      orderIndex: 1,
      plaintext: "A cat sat quietly.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "heading",
      entryId: "b-3",
      mdastJson: paragraph,
      orderIndex: 0,
      plaintext: "The Dog and the Bone.",
      readingUnitEntryId: "unit-2",
      workEntryId: "work-2"
    },
    {
      blockType: "paragraph",
      deletedAt: new Date(),
      entryId: "b-4",
      mdastJson: paragraph,
      orderIndex: 2,
      plaintext: "A soft-deleted dog line.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-5",
      mdastJson: paragraph,
      orderIndex: 3,
      plaintext: "A detached dog line.",
      readingUnitEntryId: null,
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-6",
      mdastJson: paragraph,
      orderIndex: 4,
      plaintext: "Gave 100% effort near the dog_house.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-7",
      mdastJson: paragraph,
      orderIndex: 0,
      plaintext: "我有一只狗。",
      readingUnitEntryId: "unit-3",
      workEntryId: "work-3"
    },
    {
      blockType: "paragraph",
      entryId: "b-8",
      mdastJson: paragraph,
      orderIndex: 0,
      plaintext: "A second-chapter dog returns.",
      readingUnitEntryId: "unit-1b",
      workEntryId: "work-1"
    }
  ]);
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  await seed(db);
  server = createServer({ logger: false, search: { db } });
});

afterEach(async () => {
  await server.close();
});

describe("escapeLikePattern", () => {
  it("escapes the LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("leaves an ordinary term untouched", () => {
    expect(escapeLikePattern("dog")).toBe("dog");
  });
});

describe("searchBlocks", () => {
  it("matches blocks case-insensitively, ordered by work title then reading order", async () => {
    const results = await searchBlocks(db, "dog");

    expect(results.map((result) => result.blockEntryId)).toEqual(["b-1", "b-6", "b-8", "b-3"]);
    expect(results[0]).toEqual({
      authorName: "George Orwell",
      blockEntryId: "b-1",
      plaintext: "The dog barked loudly.",
      workEntryId: "work-1",
      workTitle: "Animal Farm"
    });
  });

  it("orders a multi-unit work by reading unit then block order, not block order alone", async () => {
    // work-1 spans unit-1 (order 0; blocks b-1@0, b-6@4) and unit-1b (order 1; block b-8@0). Ordering
    // by block index alone would interleave b-8 (index 0) before b-6 (index 4); reading order keeps
    // all of unit-1 before unit-1b.
    const results = await searchBlocks(db, "dog");
    const work1Ids = results
      .filter((result) => result.workEntryId === "work-1")
      .map((result) => result.blockEntryId);

    expect(work1Ids).toEqual(["b-1", "b-6", "b-8"]);
  });

  it("matches a CJK substring without word segmentation", async () => {
    const results = await searchBlocks(db, "狗");

    expect(results.map((result) => result.blockEntryId)).toEqual(["b-7"]);
    expect(results[0]?.workTitle).toBe("寓言");
  });

  it("excludes soft-deleted and unit-detached blocks", async () => {
    const results = await searchBlocks(db, "dog");
    const ids = results.map((result) => result.blockEntryId);

    expect(ids).not.toContain("b-4");
    expect(ids).not.toContain("b-5");
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    const results = await searchBlocks(db, "%");

    // Only the block that literally contains "%" matches; a broken escape would match every block.
    expect(results.map((result) => result.blockEntryId)).toEqual(["b-6"]);
  });

  it("returns an empty list when nothing matches", async () => {
    expect(await searchBlocks(db, "unicorn")).toEqual([]);
  });
});

describe("GET /api/search", () => {
  it("returns 200 with the normalized query and ordered hits", async () => {
    const response = await server.inject({ method: "GET", url: "/api/search?q=%20dog%20" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      query: string;
      results: ReadonlyArray<{ blockEntryId: string }>;
    };
    expect(body.query).toBe("dog");
    expect(body.results.map((result) => result.blockEntryId)).toEqual(["b-1", "b-6", "b-8", "b-3"]);
  });

  it("returns 200 with an empty result set when nothing matches", async () => {
    const response = await server.inject({ method: "GET", url: "/api/search?q=unicorn" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ query: "unicorn", results: [] });
  });

  it("rejects a missing query with 400", async () => {
    const response = await server.inject({ method: "GET", url: "/api/search" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a blank query with 400", async () => {
    const response = await server.inject({ method: "GET", url: "/api/search?q=%20%20" });

    expect(response.statusCode).toBe(400);
  });
});

// A PM-backed (EPUB) work renders its `doc_blocks`, so search must return the doc_block id — the id
// the reader stamps as `data-block-id` — not the legacy mdast block id, or a result would deep-link
// to a block the reader never renders and scroll-to-block would no-op (#312).
describe("searchBlocks over PM-backed (EPUB) units", () => {
  type EpubContext = Readonly<{
    db: DbClient;
    imagesDir: string;
    server: ReturnType<typeof createServer>;
    sourcesDir: string;
  }>;

  let epub: EpubContext;

  // One EPUB chapter whose ingestion dual-writes a legacy mdast block AND a PM doc_block per node, so
  // the same paragraph text exists in both substrates — the case the per-unit preference must resolve.
  function brownFoxEpub(): ParsedEpub {
    return {
      chapters: [{ html: "<h1>Chapter One</h1><p>The quick brown fox.</p>", images: [] }],
      metadata: { author: "Aesop", language: "en", title: "Fables" }
    };
  }

  async function buildEpubContext(): Promise<EpubContext> {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const database = createDbClient(pglite);
    const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-search-epub-"));
    const imagesDir = await mkdtemp(join(tmpdir(), "whetstone-search-epub-img-"));

    let workSequence = 0;
    let entrySequence = 0;
    let sourceSequence = 0;
    let authorSequence = 0;
    const library: LibraryDependencies = {
      createAuthorId: () => `author-${(workSequence += 1)}`,
      createEntryId: () => `work-${workSequence}`,
      db: database
    };
    const content: ContentDependencies = {
      createAuthorId: () => `epub-author-${(authorSequence += 1)}`,
      createEntryId: () => `entry-${(entrySequence += 1)}`,
      createSourceId: () => `source-${(sourceSequence += 1)}`,
      db: database,
      epubParser: async () => brownFoxEpub(),
      imageResourceStore: createImageResourceStore(imagesDir),
      ingestionLogger: () => {},
      sourceFileStore: createSourceFileStore(sourcesDir)
    };

    return {
      db: database,
      imagesDir,
      server: createServer({ content, library, logger: false, search: { db: database } }),
      sourcesDir
    };
  }

  beforeEach(async () => {
    epub = await buildEpubContext();
  });

  afterEach(async () => {
    await epub.server.close();
    await rm(epub.sourcesDir, { force: true, recursive: true });
    await rm(epub.imagesDir, { force: true, recursive: true });
  });

  it("returns the rendered doc_block id for an EPUB hit, never the legacy mdast block id", async () => {
    const response = await epub.server.inject({
      headers: { "content-type": epubContentType },
      method: "POST",
      payload: Buffer.from("epub-search-fox"),
      url: "/api/works/epub"
    });
    expect(response.statusCode).toBe(201);

    // The paragraph exists in both substrates: the PM doc_block the reader renders and the legacy
    // mdast block search used to return. The fix returns the doc_block id and excludes the legacy one.
    const [docBlockRow] = (await epub.db.select().from(docBlocks)).filter((row) =>
      row.plaintext.includes("quick")
    );
    const [legacyRow] = (await epub.db.select().from(blocks)).filter((row) =>
      row.plaintext.includes("quick")
    );
    expect(docBlockRow).toBeDefined();
    expect(legacyRow).toBeDefined();
    expect(docBlockRow?.id).not.toBe(legacyRow?.entryId);

    const results = await searchBlocks(epub.db, "quick");
    const ids = results.map((result) => result.blockEntryId);

    expect(ids).toContain(docBlockRow?.id);
    expect(ids).not.toContain(legacyRow?.entryId);
    expect(results.find((result) => result.blockEntryId === docBlockRow?.id)?.plaintext).toBe(
      "The quick brown fox."
    );
  });
});
