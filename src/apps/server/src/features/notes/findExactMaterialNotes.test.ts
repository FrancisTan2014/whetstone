import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { notes } from "../../db/schema.js";
import { deleteNoteInTx, insertNoteInTx } from "./noteCommands.js";
import { findExactMaterialNotes } from "./noteQueries.js";
import { fingerprintNoteMaterial } from "./noteMaterialFingerprint.js";

// #711 owner-scoped exact-material query. It returns every body-bearing note the current owner holds
// whose canonical projection equals a given document, in creation/id order, writing nothing. These tests
// seed real notes through the single insert boundary (so the fingerprint is written the production way)
// and cover 0/1/many, owner isolation, mark/deleted exclusion, stable ordering, a forced SHA collision
// rejected by full projection equality, and that every query path writes zero rows.

const OWNER = "user-1";
const OTHER = "user-2";

let db: DbClient;

async function seedNote(params: {
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  entryId: string;
  kind?: "note" | "mark";
  now: string;
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
      now: new Date(params.now),
      userId: params.userId ?? OWNER
    })
  );
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("findExactMaterialNotes", () => {
  it("returns nothing when the owner has no matching material", async () => {
    await seedNote({
      bodyDoc: createTextDocument("Something else"),
      bodyText: "Something else",
      entryId: "note-1",
      now: "2026-01-01T00:00:00.000Z"
    });
    const matches = await findExactMaterialNotes(db, {
      bodyDoc: createTextDocument("Target material"),
      userId: OWNER
    });
    expect(matches).toEqual([]);
  });

  it("returns the single owned note whose material matches, regardless of renderer noise", async () => {
    await seedNote({
      bodyDoc: createTextDocument("Target material"),
      bodyText: "Target material",
      entryId: "note-1",
      now: "2026-01-01T00:00:00.000Z"
    });
    // A bold-only, whitespace-padded variant projects to the same material.
    const query: DocumentNodeJSON = {
      content: [
        {
          content: [{ marks: [{ type: "bold" }], text: "  Target material  ", type: "text" }],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    const matches = await findExactMaterialNotes(db, { bodyDoc: query, userId: OWNER });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.noteEntryId).toBe("note-1");
    expect(matches[0]?.bodyText).toBe("Target material");
  });

  it("returns every match in creation then id order", async () => {
    // Two notes at the same instant (id breaks the tie) and one earlier note.
    await seedNote({
      bodyDoc: createTextDocument("Same"),
      bodyText: "Same",
      entryId: "note-b",
      now: "2026-01-02T00:00:00.000Z"
    });
    await seedNote({
      bodyDoc: createTextDocument("Same"),
      bodyText: "Same",
      entryId: "note-a",
      now: "2026-01-02T00:00:00.000Z"
    });
    await seedNote({
      bodyDoc: createTextDocument("Same"),
      bodyText: "Same",
      entryId: "note-earlier",
      now: "2026-01-01T00:00:00.000Z"
    });
    const matches = await findExactMaterialNotes(db, {
      bodyDoc: createTextDocument("Same"),
      userId: OWNER
    });
    expect(matches.map((match) => match.noteEntryId)).toEqual(["note-earlier", "note-a", "note-b"]);
  });

  it("excludes another owner's identical material", async () => {
    await seedNote({
      bodyDoc: createTextDocument("Target material"),
      bodyText: "Target material",
      entryId: "note-mine",
      now: "2026-01-01T00:00:00.000Z"
    });
    await seedNote({
      bodyDoc: createTextDocument("Target material"),
      bodyText: "Target material",
      entryId: "note-theirs",
      now: "2026-01-01T00:00:00.000Z",
      userId: OTHER
    });
    const matches = await findExactMaterialNotes(db, {
      bodyDoc: createTextDocument("Target material"),
      userId: OWNER
    });
    expect(matches.map((match) => match.noteEntryId)).toEqual(["note-mine"]);
  });

  it("excludes marks and hard-deleted notes", async () => {
    await seedNote({
      bodyDoc: null,
      bodyText: null,
      entryId: "mark-1",
      kind: "mark",
      now: "2026-01-01T00:00:00.000Z"
    });
    await seedNote({
      bodyDoc: createTextDocument("Target material"),
      bodyText: "Target material",
      entryId: "note-deleted",
      now: "2026-01-01T00:00:00.000Z"
    });
    await db.transaction((tx) => deleteNoteInTx(tx, "note-deleted"));

    const matches = await findExactMaterialNotes(db, {
      bodyDoc: createTextDocument("Target material"),
      userId: OWNER
    });
    expect(matches).toEqual([]);
  });

  it("rejects a forced fingerprint collision via full projection equality", async () => {
    const target = createTextDocument("Target material");
    const fingerprint = fingerprintNoteMaterial(target);

    await seedNote({
      bodyDoc: target,
      bodyText: "Target material",
      entryId: "note-real",
      now: "2026-01-01T00:00:00.000Z"
    });
    // A DIFFERENT note forced to carry the target's fingerprint (a stand-in for a SHA-256 collision):
    // the shape constraint still holds (a note with a non-null fingerprint), but its projection differs.
    await seedNote({
      bodyDoc: createTextDocument("Different material"),
      bodyText: "Different material",
      entryId: "note-collision",
      now: "2026-01-01T00:00:00.000Z"
    });
    await db
      .update(notes)
      .set({ materialFingerprint: fingerprint })
      .where(eq(notes.entryId, "note-collision"));

    const matches = await findExactMaterialNotes(db, { bodyDoc: target, userId: OWNER });
    expect(matches.map((match) => match.noteEntryId)).toEqual(["note-real"]);
  });

  it("writes zero rows on every query path", async () => {
    await seedNote({
      bodyDoc: createTextDocument("Target material"),
      bodyText: "Target material",
      entryId: "note-1",
      now: "2026-01-01T00:00:00.000Z"
    });
    const before = await db.select().from(notes).orderBy(notes.entryId);

    await findExactMaterialNotes(db, {
      bodyDoc: createTextDocument("Target material"),
      userId: OWNER
    });
    await findExactMaterialNotes(db, { bodyDoc: createTextDocument("No match"), userId: OWNER });

    const after = await db.select().from(notes).orderBy(notes.entryId);
    expect(after).toEqual(before);
  });
});
