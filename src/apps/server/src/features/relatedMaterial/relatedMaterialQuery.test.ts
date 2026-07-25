import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, noteAnchors } from "../../db/schema.js";
import type { LexicalRelationGroup } from "../lexical/lexicalNoteQuery.js";
import { toEntryId, type EntryId } from "@whetstone/domain";
import { enrichRelatedMaterialGroups } from "./relatedMaterialQuery.js";

// Enrichment of the lexical service's typed groups (#715) into the New-card disclosure DTOs (#716): each
// related note keeps its saved word (the connecting surface) and gains its capture context (the anchor's
// selected text), preserving the service's group order and per-relation membership. It reads only; nothing is
// written or reordered here.

let pglite: PGlite;
let db: DbClient;

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

// Seed one note entry and, when a context is given, its anchor selected-text snapshot. The anchor's block
// references self so a single entry satisfies every foreign key (enrichment only reads `note_anchors`).
async function seedNote(id: string, context: string | null): Promise<EntryId> {
  await db.insert(entries).values({ id, type: "note" });
  if (context !== null) {
    await db.insert(noteAnchors).values({
      blockEntryId: id,
      contextSnapshot: context,
      endBlockEntryId: id,
      endOffset: null,
      noteEntryId: id,
      selectedText: context,
      startOffset: null
    });
  }
  return toEntryId(id);
}

function group(
  relation: LexicalRelationGroup["relation"],
  direction: LexicalRelationGroup["direction"],
  notes: ReadonlyArray<{ noteEntryId: EntryId; surface: string }>
): LexicalRelationGroup {
  return { relation, direction, source: "morphology", notes };
}

describe("enrichRelatedMaterialGroups", () => {
  it("returns nothing for no groups without touching the database", async () => {
    expect(await enrichRelatedMaterialGroups(db, [])).toEqual([]);
  });

  it("carries each note's saved word and its anchor context, or null when unanchored", async () => {
    const anchored = await seedNote("note-anchored", "she was born in May");
    const bare = await seedNote("note-bare", null);

    const groups = [
      group("inflection", "lateral", [
        { noteEntryId: anchored, surface: "born" },
        { noteEntryId: bare, surface: "bore" }
      ]),
      group("hypernym", "broader", [{ noteEntryId: bare, surface: "produce" }])
    ];

    expect(await enrichRelatedMaterialGroups(db, groups)).toEqual([
      {
        relation: "inflection",
        direction: "lateral",
        notes: [
          { noteId: "note-anchored", word: "born", context: "she was born in May" },
          { noteId: "note-bare", word: "bore", context: null }
        ]
      },
      {
        relation: "hypernym",
        direction: "broader",
        notes: [{ noteId: "note-bare", word: "produce", context: null }]
      }
    ]);
  });
});
