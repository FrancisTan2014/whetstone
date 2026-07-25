import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createTextDocument,
  projectNearMatchKey,
  type DocumentNodeJSON
} from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { insertNoteInTx, updateNoteBodyInTx } from "./noteCommands.js";
import { findNearMatchNotes } from "./noteNearMatchQuery.js";

// #713 owner-scoped near-match query + write boundary. These tests seed real notes through the single insert
// boundary (so the relaxed key + length are written the production way), then assert the read-only query
// surfaces high-precision near matches: it excludes exact and self, isolates by owner, drops marks and
// out-of-band lengths, orders stably, and writes nothing. They also lock that the write boundary persists the
// paired key columns on insert and recomputes them on edit (flipping eligibility both ways).

const OWNER = "user-1";
const OTHER = "user-2";

let db: DbClient;
let pglite: PGlite;

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

async function persistedKey(
  entryId: string
): Promise<{ relaxedKey: string | null; relaxedKeyLength: number | null }> {
  const result = await pglite.query<{
    relaxed_key: string | null;
    relaxed_key_length: number | null;
  }>(`SELECT relaxed_key, relaxed_key_length FROM notes WHERE entry_id = $1`, [entryId]);
  const row = result.rows[0]!;
  return { relaxedKey: row.relaxed_key, relaxedKeyLength: row.relaxed_key_length };
}

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("note near-match write boundary", () => {
  it("persists the paired key columns for an eligible note", async () => {
    const body = createTextDocument("in terms of the design");
    await seedNote({ bodyDoc: body, bodyText: "in terms of the design", entryId: "note-1" });
    expect(await persistedKey("note-1")).toEqual({
      relaxedKey: projectNearMatchKey(body)!.relaxedKey,
      relaxedKeyLength: projectNearMatchKey(body)!.codePointLength
    });
  });

  it("leaves both columns null for a mark and for an unsupported note", async () => {
    await seedNote({ bodyDoc: null, bodyText: null, entryId: "mark-1", kind: "mark" });
    await seedNote({
      bodyDoc: createTextDocument("distributed"),
      bodyText: "distributed",
      entryId: "note-single"
    });
    expect(await persistedKey("mark-1")).toEqual({ relaxedKey: null, relaxedKeyLength: null });
    expect(await persistedKey("note-single")).toEqual({ relaxedKey: null, relaxedKeyLength: null });
  });

  it("recomputes the key on edit, flipping eligibility both ways", async () => {
    await seedNote({
      bodyDoc: createTextDocument("distributed"),
      bodyText: "distributed",
      entryId: "note-flip"
    });
    expect((await persistedKey("note-flip")).relaxedKey).toBeNull();

    const eligible = createTextDocument("now this is proper prose");
    await db.transaction((tx) =>
      updateNoteBodyInTx(tx, {
        bodyDoc: eligible,
        noteEntryId: "note-flip",
        now: new Date("2026-02-01T00:00:00.000Z")
      })
    );
    expect((await persistedKey("note-flip")).relaxedKey).toBe(
      projectNearMatchKey(eligible)!.relaxedKey
    );

    // Editing it back down to a single word clears the columns again.
    await db.transaction((tx) =>
      updateNoteBodyInTx(tx, {
        bodyDoc: createTextDocument("singleton"),
        noteEntryId: "note-flip",
        now: new Date("2026-03-01T00:00:00.000Z")
      })
    );
    expect(await persistedKey("note-flip")).toEqual({ relaxedKey: null, relaxedKeyLength: null });
  });
});

describe("findNearMatchNotes", () => {
  it("returns nothing for an unsupported target body", async () => {
    await seedNote({
      bodyDoc: createTextDocument("in terms of the design"),
      bodyText: "in terms of the design",
      entryId: "note-1"
    });
    expect(
      await findNearMatchNotes(db, { bodyDoc: createTextDocument("word"), userId: OWNER })
    ).toEqual([]);
  });

  it("surfaces a typo variant while excluding exact material and the owner's unrelated notes", async () => {
    await seedNote({
      bodyDoc: createTextDocument("in term of the design"),
      bodyText: "in term of the design",
      entryId: "note-typo"
    });
    await seedNote({
      bodyDoc: createTextDocument("in terms of the design"),
      bodyText: "in terms of the design",
      entryId: "note-exact"
    });
    await seedNote({
      bodyDoc: createTextDocument("a completely unrelated sentence here"),
      bodyText: "a completely unrelated sentence here",
      entryId: "note-unrelated"
    });

    const matches = await findNearMatchNotes(db, {
      bodyDoc: createTextDocument("in terms of the design"),
      userId: OWNER
    });
    expect(matches.map((match) => match.noteEntryId)).toEqual([toEntryId("note-typo")]);
    expect(matches[0]!.score).toBeGreaterThan(0.84);
    expect(matches[0]!.bodyText).toBe("in term of the design");
    // The case-sensitive relaxed key is carried through for the review's factual word differences (#714).
    expect(matches[0]!.caseSensitiveKey).toBe("in term of the design");
  });

  it("excludes the target note itself and isolates by owner", async () => {
    await seedNote({
      bodyDoc: createTextDocument("in terms of the design"),
      bodyText: "in terms of the design",
      entryId: "note-self"
    });
    await seedNote({
      bodyDoc: createTextDocument("in term of the design"),
      bodyText: "in term of the design",
      entryId: "note-other-user",
      userId: OTHER
    });

    const matches = await findNearMatchNotes(db, {
      bodyDoc: createTextDocument("in terms of the design"),
      excludeNoteEntryId: "note-self",
      userId: OWNER
    });
    // The only similar note belongs to another owner, and self is excluded, so nothing is returned.
    expect(matches).toEqual([]);
  });

  it("excludes marks and drops out-of-band lengths", async () => {
    await seedNote({ bodyDoc: null, bodyText: null, entryId: "mark-1", kind: "mark" });
    // A far shorter note cannot clear the threshold, so the length band never loads it.
    await seedNote({
      bodyDoc: createTextDocument("tiny note"),
      bodyText: "tiny note",
      entryId: "note-short"
    });
    await seedNote({
      bodyDoc: createTextDocument("in term of the design"),
      bodyText: "in term of the design",
      entryId: "note-typo"
    });

    const matches = await findNearMatchNotes(db, {
      bodyDoc: createTextDocument("in terms of the design"),
      userId: OWNER
    });
    expect(matches.map((match) => match.noteEntryId)).toEqual([toEntryId("note-typo")]);
  });

  it("orders candidates by score descending then note id, and writes nothing", async () => {
    await seedNote({
      bodyDoc: createTextDocument("consider the parsor design today"),
      bodyText: "consider the parsor design today",
      entryId: "note-b-one"
    });
    await seedNote({
      bodyDoc: createTextDocument("consider the parsee desigm today"),
      bodyText: "consider the parsee desigm today",
      entryId: "note-a-two"
    });
    await seedNote({
      bodyDoc: createTextDocument("consider the parsee design today"),
      bodyText: "consider the parsee design today",
      entryId: "note-a-one"
    });

    const before = await pglite.query(
      `SELECT entry_id, relaxed_key, relaxed_key_length, body_doc FROM notes`
    );
    const matches = await findNearMatchNotes(db, {
      bodyDoc: createTextDocument("consider the parser design today"),
      userId: OWNER
    });
    const after = await pglite.query(
      `SELECT entry_id, relaxed_key, relaxed_key_length, body_doc FROM notes`
    );

    // The one-edit variants outscore the two-edit one; among the equal-score pair, note id breaks the tie
    // ascending — so score wins over id (note-a-two sorts last despite its id).
    expect(matches.map((match) => match.noteEntryId)).toEqual([
      toEntryId("note-a-one"),
      toEntryId("note-b-one"),
      toEntryId("note-a-two")
    ]);
    for (let index = 1; index < matches.length; index += 1) {
      expect(matches[index]!.score).toBeLessThanOrEqual(matches[index - 1]!.score);
    }
    // The query is strictly read-only: no row changed.
    expect(after.rows).toEqual(before.rows);
  });
});
