import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, blocks, entries, readingUnits, workMeta } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
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
    { id: "unit-2", type: "reading_unit" },
    { id: "unit-3", type: "reading_unit" },
    { id: "b-1", type: "block" },
    { id: "b-2", type: "block" },
    { id: "b-3", type: "block" },
    { id: "b-4", type: "block" },
    { id: "b-5", type: "block" },
    { id: "b-6", type: "block" },
    { id: "b-7", type: "block" }
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
  it("matches blocks case-insensitively, ordered by work title then block order", async () => {
    const results = await searchBlocks(db, "dog");

    expect(results.map((result) => result.blockEntryId)).toEqual(["b-1", "b-6", "b-3"]);
    expect(results[0]).toEqual({
      authorName: "George Orwell",
      blockEntryId: "b-1",
      plaintext: "The dog barked loudly.",
      workEntryId: "work-1",
      workTitle: "Animal Farm"
    });
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
    expect(body.results.map((result) => result.blockEntryId)).toEqual(["b-1", "b-6", "b-3"]);
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
