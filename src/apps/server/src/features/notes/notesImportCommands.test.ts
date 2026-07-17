import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportNotesRequest } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  entries,
  entryLinks,
  memoryPrompts,
  notes,
  personalEntries,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import type { NotesDependencies } from "./noteCommands.js";
import { importNotesBatch } from "./notesImportCommands.js";

const userId = "user-import";
const now = new Date("2026-03-01T00:00:00.000Z");

type TestContext = Readonly<{
  db: DbClient;
  deps: (createEntryId: () => string) => NotesDependencies;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return {
    db,
    deps: (createEntryId) => ({ createEntryId, db, now: () => now })
  };
}

function itemFrom(question: string, note: string): ImportNotesRequest["items"][number] {
  return { noteDoc: createTextDocument(note), questionDoc: createTextDocument(question) };
}

function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("importNotesBatch", () => {
  it("creates one standalone note and one cardless current-note prompt per row, in pasted order", async () => {
    const deps = context.deps(sequentialIds("id"));
    const items: ImportNotesRequest["items"] = [
      itemFrom("What is a WAL?", "A write-ahead log records changes before applying them."),
      itemFrom("Define quorum", "A quorum is a majority of replicas.")
    ];

    const result = await importNotesBatch(deps, items, userId);

    expect(result.imported).toHaveLength(2);
    // Ids are minted in pasted order: note then prompt per row.
    expect(result.imported.map((row) => row.noteEntryId)).toEqual(["id-1", "id-3"]);
    expect(result.imported.map((row) => row.promptId)).toEqual(["id-2", "id-4"]);

    const noteRows = await context.db.select().from(notes).orderBy(notes.entryId);
    expect(noteRows).toHaveLength(2);
    for (const row of noteRows) {
      expect(row.kind).toBe("note");
      expect(row.captureSource).toBe("import");
    }
    const byId = new Map(noteRows.map((row) => [row.entryId, row]));
    expect(byId.get("id-1")?.bodyText).toBe(
      "A write-ahead log records changes before applying them."
    );
    expect(byId.get("id-3")?.bodyText).toBe("A quorum is a majority of replicas.");

    const promptRows = await context.db.select().from(memoryPrompts).orderBy(memoryPrompts.entryId);
    expect(promptRows).toHaveLength(2);
    for (const row of promptRows) {
      expect(row.revealKind).toBe("current_note");
      expect(row.lifecycle).toBe("ready");
      expect(row.answerDoc).toBeNull();
      expect(row.answerText).toBeNull();
      expect(row.chunkId).toBeNull();
    }
    const promptById = new Map(promptRows.map((row) => [row.entryId, row]));
    expect(promptById.get("id-2")?.cueText).toBe("What is a WAL?");
    expect(promptById.get("id-2")?.noteEntryId).toBe("id-1");
    expect(promptById.get("id-4")?.cueText).toBe("Define quorum");
    expect(promptById.get("id-4")?.noteEntryId).toBe("id-3");
  });

  it("writes owner facets and note→prompt links but no review card or event", async () => {
    const deps = context.deps(sequentialIds("id"));
    const items = [itemFrom("Q", "N")];

    await importNotesBatch(deps, items, userId);

    const owners = await context.db.select().from(personalEntries);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(userId);
    expect(owners[0]?.entryId).toBe("id-1");

    const links = await context.db.select().from(entryLinks).where(eq(entryLinks.type, "contains"));
    expect(links).toEqual([
      expect.objectContaining({ fromEntryId: "id-1", toEntryId: "id-2", type: "contains" })
    ]);

    // Cardless: an imported note enters Review only when deliberately added later.
    expect(await context.db.select().from(reviewCards)).toHaveLength(0);
    expect(await context.db.select().from(reviewEvents)).toHaveLength(0);

    const entryTypes = await context.db.select().from(entries).orderBy(entries.id);
    expect(entryTypes.map((row) => [row.id, row.type])).toEqual([
      ["id-1", "note"],
      ["id-2", "memory_prompt"]
    ]);
  });

  it("scopes imported notes to the requesting user", async () => {
    const deps = context.deps(sequentialIds("id"));

    await importNotesBatch(deps, [itemFrom("Q", "N")], "user-other");

    const owner = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, "id-1"));
    expect(owner[0]?.userId).toBe("user-other");
  });

  it("rolls the whole batch back when any row fails, leaving Notes untouched", async () => {
    // A colliding note id makes the second note insert violate the entries primary key mid-transaction.
    const collidingIds = ["id-1", "id-2", "id-1", "id-4"];
    let index = 0;
    const deps = context.deps(() => collidingIds[index++] ?? "overflow");
    const items: ImportNotesRequest["items"] = [itemFrom("Q1", "N1"), itemFrom("Q2", "N2")];

    await expect(importNotesBatch(deps, items, userId)).rejects.toThrow();

    expect(await context.db.select().from(notes)).toHaveLength(0);
    expect(await context.db.select().from(memoryPrompts)).toHaveLength(0);
    expect(await context.db.select().from(entries)).toHaveLength(0);
    expect(await context.db.select().from(personalEntries)).toHaveLength(0);
    expect(await context.db.select().from(entryLinks)).toHaveLength(0);
  });
});
