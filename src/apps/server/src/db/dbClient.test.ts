import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";
import { createDbClient } from "./dbClient.js";
import { authors, entries, entryLinks, readingUnitMeta, workMeta } from "./schema.js";

describe("createDbClient", () => {
  it("creates a drizzle client with the generated schema", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);

    const db = createDbClient(pglite);
    const workMetaConfig = getTableConfig(workMeta);
    const readingUnitMetaConfig = getTableConfig(readingUnitMeta);
    const entryLinksConfig = getTableConfig(entryLinks);

    await db.insert(authors).values({ id: "author-1", name: "Octavia Butler" });
    await db.insert(entries).values({ id: "work-1", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-1",
      entryId: "work-1",
      language: "en",
      title: "Parable of the Sower",
      workType: "book"
    });
    await db.insert(entries).values({ id: "reading-unit-1", type: "reading_unit" });
    await db.insert(readingUnitMeta).values({
      entryId: "reading-unit-1",
      markdownFilePath: "reading-units/reading-unit-1.md",
      orderIndex: 0,
      title: "Chapter 1",
      workId: "work-1"
    });
    await db.insert(entryLinks).values({
      fromEntryId: "work-1",
      linkType: "contains",
      toEntryId: "reading-unit-1"
    });

    const authorRows = await db.select().from(authors);
    const entryRows = await db.select().from(entries);
    const workRows = await db.select().from(workMeta);
    const unitRows = await db.select().from(readingUnitMeta);
    const linkRows = await db.select().from(entryLinks);

    expect(authorRows).toEqual([{ id: "author-1", name: "Octavia Butler" }]);
    expect(entryRows).toEqual([
      { id: "work-1", type: "work" },
      { id: "reading-unit-1", type: "reading_unit" }
    ]);
    expect(workRows).toEqual([
      {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Parable of the Sower",
        workType: "book"
      }
    ]);
    expect(unitRows).toEqual([
      {
        entryId: "reading-unit-1",
        markdownFilePath: "reading-units/reading-unit-1.md",
        orderIndex: 0,
        title: "Chapter 1",
        workId: "work-1"
      }
    ]);
    expect(linkRows).toEqual([
      {
        fromEntryId: "work-1",
        linkType: "contains",
        toEntryId: "reading-unit-1"
      }
    ]);
    expect(workMetaConfig.foreignKeys).toHaveLength(2);
    expect(readingUnitMetaConfig.foreignKeys).toHaveLength(2);
    expect(readingUnitMetaConfig.indexes).toHaveLength(1);
    expect(entryLinksConfig.foreignKeys).toHaveLength(2);
    expect(entryLinksConfig.indexes).toHaveLength(1);
    expect(entryLinksConfig.primaryKeys).toHaveLength(1);
  });
});
