import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";
import { toEntryId, type LexicalRelationType } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { notes } from "../../db/schema.js";
import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";
import { deleteNoteInTx, insertNoteInTx } from "../notes/noteCommands.js";
import { findRelatedLexicalNotes } from "./lexicalNoteQuery.js";
import type { SenseRelationContext } from "./wordnetLexicalProvider.js";

// #715 owner-scoped, read-only related-note query. Notes are seeded through the single insert boundary (so
// the material fingerprint is written the production way) and typed against a fixed sense context. Coverage:
// every relation family, exact/unrelated/multiword exclusion, owner isolation, mark + hard-delete exclusion,
// the per-relation cap in stable id order, priority-ordered groups, and that every path writes zero rows.

const OWNER = "user-1";
const OTHER = "user-2";

// A deterministic lemmatizer: only "cars" reduces to "car" (the selected lemma), so exactly one seeded note
// is an inflection; everything else is decided by set membership.
const lemmatize: LexicalLemmatizer = (surface, pos) =>
  surface === "cars" && pos === "noun" ? "car" : surface;

function contextFor(sets: Record<string, readonly string[]>): SenseRelationContext {
  const relationSets = new Map<LexicalRelationType, ReadonlySet<string>>();
  for (const [relation, keys] of Object.entries(sets)) {
    relationSets.set(relation as LexicalRelationType, new Set(keys));
  }
  return { surfaceKey: "car", selectedLemma: "car", partOfSpeech: "noun", relationSets };
}

let db: DbClient;

async function seedNote(params: {
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  entryId: string;
  kind?: "note" | "mark";
  now?: string;
  userId?: string;
}): Promise<void> {
  await db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor: null,
      bodyDoc: params.bodyDoc,
      bodyText: params.bodyText,
      captureSource: "manual",
      kind: params.kind ?? "note",
      noteEntryId: toEntryId(params.entryId),
      now: new Date(params.now ?? "2026-01-01T00:00:00.000Z"),
      userId: params.userId ?? OWNER
    })
  );
}

async function seedWord(entryId: string, word: string, userId = OWNER): Promise<void> {
  await seedNote({ bodyDoc: createTextDocument(word), bodyText: word, entryId, userId });
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("findRelatedLexicalNotes", () => {
  it("groups owned single-word notes by relation in priority order with correct facets", async () => {
    await seedWord("note-01-cars", "cars"); // inflection
    await seedWord("note-02-auto", "auto"); // synonym
    await seedWord("note-03-machine", "machine"); // hypernym
    await seedWord("note-04-cab", "cab"); // hyponym
    await seedWord("note-05-driving", "driving"); // derivation
    await seedWord("note-06-car", "car"); // exact material → excluded
    await seedWord("note-07-banana", "banana"); // unrelated → excluded
    await seedNote({
      bodyDoc: createTextDocument("motor vehicle"),
      bodyText: "motor vehicle",
      entryId: "note-08-multiword" // not a single word → excluded
    });

    const groups = await findRelatedLexicalNotes(
      db,
      contextFor({
        synonym: ["auto", "automobile"],
        derivation: ["driving"],
        hypernym: ["machine"],
        hyponym: ["cab", "taxi"]
      }),
      lemmatize,
      { userId: OWNER }
    );

    expect(groups.map((group) => group.relation)).toEqual([
      "inflection",
      "synonym",
      "derivation",
      "hypernym",
      "hyponym"
    ]);
    const hypernym = groups.find((group) => group.relation === "hypernym");
    expect(hypernym?.direction).toBe("broader");
    expect(hypernym?.source).toBe("semantic");
    const hyponym = groups.find((group) => group.relation === "hyponym");
    expect(hyponym?.direction).toBe("narrower");
    const inflection = groups.find((group) => group.relation === "inflection");
    expect(inflection?.notes.map((note) => note.surface)).toEqual(["cars"]);
    expect(inflection?.notes[0]?.noteEntryId).toBe("note-01-cars");
  });

  it("caps each relation at five notes in stable id order", async () => {
    const hyponyms = ["cab", "taxi", "coupe", "sedan", "hatchback", "convertible", "roadster"];
    for (const [index, word] of hyponyms.entries()) {
      await seedWord(`note-h${index + 1}`, word);
    }

    const groups = await findRelatedLexicalNotes(db, contextFor({ hyponym: hyponyms }), lemmatize, {
      userId: OWNER
    });

    const hyponym = groups.find((group) => group.relation === "hyponym");
    expect(hyponym?.notes).toHaveLength(5);
    expect(hyponym?.notes.map((note) => note.noteEntryId)).toEqual([
      "note-h1",
      "note-h2",
      "note-h3",
      "note-h4",
      "note-h5"
    ]);
  });

  it("returns only the current owner's related notes", async () => {
    await seedWord("note-mine", "auto", OWNER);
    await seedWord("note-theirs", "auto", OTHER);

    const groups = await findRelatedLexicalNotes(db, contextFor({ synonym: ["auto"] }), lemmatize, {
      userId: OWNER
    });

    const synonym = groups.find((group) => group.relation === "synonym");
    expect(synonym?.notes.map((note) => note.noteEntryId)).toEqual(["note-mine"]);
  });

  it("excludes marks and hard-deleted notes", async () => {
    await seedNote({ bodyDoc: null, bodyText: null, entryId: "mark-auto", kind: "mark" });
    await seedWord("note-deleted", "auto");
    await db.transaction((tx) => deleteNoteInTx(tx, "note-deleted"));

    const groups = await findRelatedLexicalNotes(db, contextFor({ synonym: ["auto"] }), lemmatize, {
      userId: OWNER
    });

    expect(groups).toEqual([]);
  });

  it("writes zero rows on the query path", async () => {
    await seedWord("note-auto", "auto");
    const before = await db.select().from(notes).orderBy(notes.entryId);

    await findRelatedLexicalNotes(db, contextFor({ synonym: ["auto"] }), lemmatize, {
      userId: OWNER
    });

    const after = await db.select().from(notes).orderBy(notes.entryId);
    expect(after).toEqual(before);
  });
});
