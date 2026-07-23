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

// A block's stored mdast node carries its text. The search snippet is a readable projection of THIS
// node (the raw `plaintext` column still backs matching), so each seed block's node holds the same
// text its `plaintext` asserts. A childless paragraph would project to an empty snippet.
function textBlock(text: string): unknown {
  return { children: [{ type: "text", value: text }], type: "paragraph" };
}

// A bullet list whose stored plaintext runs the items together (the #503 defect); the readable
// snippet must reinsert a boundary between them.
function listBlock(...items: string[]): unknown {
  return {
    children: items.map((value) => ({
      children: [{ children: [{ type: "text", value }], type: "paragraph" }],
      type: "listItem"
    })),
    type: "list"
  };
}

const falconListItems = [
  "First list item mentions a falcon gliding above the valley.",
  "Second list item mentions a turtle walking the long sandy shore."
] as const;

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
    { id: "b-8", type: "block" },
    { id: "b-9", type: "block" }
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
      origin: "imported",
      title: "Animal Farm",
      workType: "book"
    },
    {
      authorId: "author-2",
      entryId: "work-2",
      language: "en",
      origin: "imported",
      title: "Fables",
      workType: "book"
    },
    {
      authorId: "author-3",
      entryId: "work-3",
      language: "zh-CN",
      origin: "imported",
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
      mdastJson: textBlock("The dog barked loudly."),
      orderIndex: 0,
      plaintext: "The dog barked loudly.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-2",
      mdastJson: textBlock("A cat sat quietly."),
      orderIndex: 1,
      plaintext: "A cat sat quietly.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "heading",
      entryId: "b-3",
      mdastJson: textBlock("The Dog and the Bone."),
      orderIndex: 0,
      plaintext: "The Dog and the Bone.",
      readingUnitEntryId: "unit-2",
      workEntryId: "work-2"
    },
    {
      blockType: "paragraph",
      deletedAt: new Date(),
      entryId: "b-4",
      mdastJson: textBlock("A soft-deleted dog line."),
      orderIndex: 2,
      plaintext: "A soft-deleted dog line.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-5",
      mdastJson: textBlock("A detached dog line."),
      orderIndex: 3,
      plaintext: "A detached dog line.",
      readingUnitEntryId: null,
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-6",
      mdastJson: textBlock("Gave 100% effort near the dog_house."),
      orderIndex: 4,
      plaintext: "Gave 100% effort near the dog_house.",
      readingUnitEntryId: "unit-1",
      workEntryId: "work-1"
    },
    {
      blockType: "paragraph",
      entryId: "b-7",
      mdastJson: textBlock("我有一只狗。"),
      orderIndex: 0,
      plaintext: "我有一只狗。",
      readingUnitEntryId: "unit-3",
      workEntryId: "work-3"
    },
    {
      blockType: "paragraph",
      entryId: "b-8",
      mdastJson: textBlock("A second-chapter dog returns."),
      orderIndex: 0,
      plaintext: "A second-chapter dog returns.",
      readingUnitEntryId: "unit-1b",
      workEntryId: "work-1"
    },
    {
      blockType: "list",
      entryId: "b-9",
      mdastJson: listBlock(...falconListItems),
      orderIndex: 1,
      // The stored plaintext runs the two list items together (the #503 defect) — search still
      // MATCHES on it, but the rendered snippet must reinsert a boundary between the items.
      plaintext: falconListItems.join(""),
      readingUnitEntryId: "unit-2",
      workEntryId: "work-2"
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
      snippet: {
        text: "The dog barked loudly.",
        matchStart: 4,
        matchEnd: 7,
        hasLeadingEllipsis: false,
        hasTrailingEllipsis: false
      },
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

  it("returns a snippet of the source plaintext for a list hit, with UTF-16 offsets over the first match", async () => {
    const results = await searchBlocks(db, "falcon");

    expect(results.map((result) => result.blockEntryId)).toEqual(["b-9"]);
    // The snippet preserves the SOURCE plaintext (the reader-aligned stream, #344) so its match
    // offsets stay canonical for highlighting/deep-linking; unlike the retired whole-block readable
    // projection (#503), it does not reinsert a boundary between the run-together list items.
    const snippet = results[0]?.snippet;
    expect(snippet?.text).toBe(falconListItems.join(""));
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("falcon");
    expect(snippet?.hasLeadingEllipsis).toBe(false);
    expect(snippet?.hasTrailingEllipsis).toBe(false);
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
  // The list exercises the #503 readable-snippet boundary on the PM (doc_block) substrate.
  function brownFoxEpub(): ParsedEpub {
    return {
      chapters: [
        {
          html:
            "<h1>Chapter One</h1><p>The quick brown fox.</p>" +
            "<ul><li>A falcon glides above the valley.</li>" +
            "<li>A turtle walks the sandy shore.</li></ul>",
          images: []
        }
      ],
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
      db: database,
      now: () => new Date()
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
    expect(results.find((result) => result.blockEntryId === docBlockRow?.id)?.snippet.text).toBe(
      "The quick brown fox."
    );
  });

  it("returns a PM (doc_block) list hit's snippet as the source plaintext, without a reinserted boundary (#503 retired)", async () => {
    const response = await epub.server.inject({
      headers: { "content-type": epubContentType },
      method: "POST",
      payload: Buffer.from("epub-search-list"),
      url: "/api/works/epub"
    });
    expect(response.statusCode).toBe(201);

    // The hit resolves to the rendered PM list doc_block; its snippet is the source plaintext window
    // (items run together), and the match offsets pick out `falcon`.
    const [results, listRow] = [
      await searchBlocks(epub.db, "falcon"),
      (await epub.db.select().from(docBlocks)).find((row) => row.plaintext.includes("falcon"))
    ];

    expect(listRow?.plaintext).toContain("valley.A turtle");
    expect(results.map((result) => result.blockEntryId)).toContain(listRow?.id);
    const snippet = results.find((result) => result.blockEntryId === listRow?.id)?.snippet;
    expect(snippet?.text).toBe(listRow?.plaintext);
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("falcon");
  });
});

// Boundedness + diversity (#726): the per-Work cap runs BEFORE the global limit, and each hit ships a
// bounded snippet around its first match. These build their own db so the fixtures are unambiguous.
describe("searchBlocks boundedness and per-Work diversity (#726)", () => {
  async function freshDb(): Promise<DbClient> {
    const pglite = new PGlite();
    await runMigrations(pglite);
    return createDbClient(pglite);
  }

  // Insert one work with `texts.length` paragraph blocks in reading order (unit order 0, block ids
  // `${prefix}-b-1..`). Block/unit/work ids are namespaced by `prefix` so multiple works coexist.
  async function insertWork(
    database: DbClient,
    prefix: string,
    title: string,
    authorName: string,
    texts: readonly string[]
  ): Promise<void> {
    const workId = `${prefix}-work`;
    const unitId = `${prefix}-unit`;
    const authorId = `${prefix}-author`;
    const blockIds = texts.map((_, index) => `${prefix}-b-${index + 1}`);

    await database.insert(entries).values([
      { id: workId, type: "work" },
      { id: unitId, type: "reading_unit" },
      ...blockIds.map((id) => ({ id, type: "block" as const }))
    ]);
    await database.insert(authors).values([{ id: authorId, name: authorName }]);
    await database.insert(workMeta).values([
      {
        authorId,
        entryId: workId,
        language: "en",
        origin: "imported",
        title,
        workType: "book"
      }
    ]);
    await database
      .insert(readingUnits)
      .values([{ entryId: unitId, orderIndex: 0, title: null, workEntryId: workId }]);
    await database.insert(blocks).values(
      texts.map((text, index) => ({
        blockType: "paragraph" as const,
        entryId: blockIds[index] as string,
        mdastJson: { children: [{ type: "text", value: text }], type: "paragraph" },
        orderIndex: index,
        plaintext: text,
        readingUnitEntryId: unitId,
        workEntryId: workId
      }))
    );
  }

  it("caps a common-term Work at five hits before the global limit, so it cannot starve other Works", async () => {
    const db = await freshDb();
    // "AAA" sorts first and has EIGHT matching blocks; "BBB" and "CCC" each have two. Without the cap
    // the first Work would dominate the leading rows; with it, every Work is represented.
    await insertWork(
      db,
      "aaa",
      "AAA Repeated",
      "Author A",
      Array.from({ length: 8 }, (_, index) => `header line ${index + 1}`)
    );
    await insertWork(db, "bbb", "BBB Other", "Author B", ["header two-one", "header two-two"]);
    await insertWork(db, "ccc", "CCC Third", "Author C", ["header three-one", "header three-two"]);

    const results = await searchBlocks(db, "header");

    const perWork = new Map<string, number>();
    for (const result of results) {
      perWork.set(result.workEntryId, (perWork.get(result.workEntryId) ?? 0) + 1);
    }

    expect(perWork.get("aaa-work")).toBe(5);
    expect(perWork.get("bbb-work")).toBe(2);
    expect(perWork.get("ccc-work")).toBe(2);
    // The five retained AAA rows are the FIRST five in reading order, not an arbitrary subset.
    expect(
      results.filter((result) => result.workEntryId === "aaa-work").map((r) => r.blockEntryId)
    ).toEqual(["aaa-b-1", "aaa-b-2", "aaa-b-3", "aaa-b-4", "aaa-b-5"]);
  });

  it("keeps deterministic global order across the capped rows", async () => {
    const db = await freshDb();
    await insertWork(db, "aaa", "AAA First", "Author A", ["term a1", "term a2"]);
    await insertWork(db, "bbb", "BBB Second", "Author B", ["term b1", "term b2"]);

    const results = await searchBlocks(db, "term");

    // Ordered by work title, then reading order within the work.
    expect(results.map((result) => result.blockEntryId)).toEqual([
      "aaa-b-1",
      "aaa-b-2",
      "bbb-b-1",
      "bbb-b-2"
    ]);
  });

  it("clips a long block to 220 code points around the first match with both ellipses", async () => {
    const db = await freshDb();
    const text = `${"x".repeat(400)}target${"y".repeat(400)}`;
    await insertWork(db, "long", "Long", "Author L", [text]);

    const [result] = await searchBlocks(db, "target");
    const snippet = result?.snippet;

    expect(snippet && Array.from(snippet.text)).toHaveLength(220);
    expect(snippet?.hasLeadingEllipsis).toBe(true);
    expect(snippet?.hasTrailingEllipsis).toBe(true);
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("target");
  });

  it("derives canonical UTF-16 offsets across astral characters before the match", async () => {
    const db = await freshDb();
    // Each 😀 is one code point but two UTF-16 units; the offset must count units, not code points.
    await insertWork(db, "astral", "Astral", "Author U", ["😀😀😀target after"]);

    const [result] = await searchBlocks(db, "target");
    const snippet = result?.snippet;

    expect(snippet?.matchStart).toBe(6);
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("target");
  });

  it("anchors the snippet on the FIRST match when a term repeats, case-insensitively", async () => {
    const db = await freshDb();
    await insertWork(db, "rep", "Repeat", "Author R", ["Dog then dog then dog"]);

    const [result] = await searchBlocks(db, "dog");
    const snippet = result?.snippet;

    // First (source-cased) match is the leading "Dog"; the offset comes from the database, not a JS
    // case-fold, so it agrees with the case-insensitive match.
    expect(snippet?.matchStart).toBe(0);
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("Dog");
  });
});
