import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createDbClient } from "./dbClient.js";
import { runMigrations } from "./migrate.js";
import { authors, entries, workMeta } from "./schema.js";

describe("createDbClient", () => {
  it("persists authors, work entries, and work metadata against the generated schema", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const db = createDbClient(pglite);

    await db.insert(authors).values({ id: "author-1", name: "Octavia Butler" });
    await db.insert(entries).values({ id: "work-1", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-1",
      entryId: "work-1",
      language: "en",
      title: "Parable of the Sower",
      workType: "book"
    });

    const authorRows = await db.select().from(authors);
    const entryRows = await db.select().from(entries);
    const workRows = await db.select().from(workMeta);

    expect(authorRows).toEqual([{ id: "author-1", name: "Octavia Butler" }]);
    expect(entryRows).toEqual([{ id: "work-1", type: "work" }]);
    expect(workRows).toEqual([
      {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Parable of the Sower",
        workType: "book"
      }
    ]);
  });

  it("declares the foreign keys and author index that the work list query relies on", () => {
    const workMetaConfig = getTableConfig(workMeta);

    expect(workMetaConfig.foreignKeys).toHaveLength(2);
    expect(workMetaConfig.indexes).toHaveLength(1);
  });
});
