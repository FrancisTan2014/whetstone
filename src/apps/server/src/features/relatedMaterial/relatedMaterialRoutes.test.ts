import { PGlite } from "@electric-sql/pglite";
import { createTextDocument } from "@whetstone/document";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  RelatedMaterialRelationsResponse,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, noteAnchors } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type {
  LexicalNoteRelations,
  LexicalOutcome,
  LexicalRelationService,
  SenseResolution
} from "../lexical/lexicalRelationService.js";

// The read-only "Find related material" routes (#716) expose the offline lexical service (#715): step 1 lists
// a drafted Answer's senses; step 2 returns the owner's typed related saved Notes under one selected sense.
// The service is faked so the route's own behavior — body validation, server-side surface projection, outcome
// mapping, and context enrichment — is asserted deterministically; the enrichment runs against a real DB.

let pglite: PGlite;
let db: DbClient;
let server: ReturnType<typeof createServer>;

// The last arguments each service method received, so the test proves the route projects the surface from the
// Answer document (never trusting the client) and forwards the owner id.
let sensesCalls: string[];
let relationsCalls: Array<{ surface: string; sense: unknown; userId: string }>;
let sensesOutcome: LexicalOutcome<SenseResolution>;
let relationsOutcome: LexicalOutcome<LexicalNoteRelations>;

const service: LexicalRelationService = {
  async resolveSenses(surface) {
    sensesCalls.push(surface);
    return sensesOutcome;
  },
  async relateNotes(_db, surface, senseRef, params) {
    relationsCalls.push({ surface, sense: senseRef, userId: params.userId });
    return relationsOutcome;
  }
};

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  sensesCalls = [];
  relationsCalls = [];
  sensesOutcome = { kind: "not_found" };
  relationsOutcome = { kind: "not_found" };
  server = createServer({ logger: false, relatedMaterial: { db, service } });
});

afterEach(async () => {
  await server.close();
  await pglite.close();
});

async function seedAnchoredNote(id: string, context: string): Promise<void> {
  await db.insert(entries).values({ id, type: "note" });
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

const sense = {
  offset: "02131653",
  partOfSpeech: "verb" as const,
  definition: "give birth",
  examples: ["she bore a son"],
  lemmas: ["bear", "birth"]
};

describe("related-material senses route", () => {
  it("rejects a malformed body", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/notes/review/related-material/senses",
      payload: { notAnswer: true }
    });
    expect(response.statusCode).toBe(400);
    expect(sensesCalls).toEqual([]);
  });

  it("projects the surface from the Answer and returns the found senses", async () => {
    sensesOutcome = { kind: "found", value: { surface: "bear", senses: [sense] } };
    const response = await server.inject({
      method: "POST",
      url: "/api/notes/review/related-material/senses",
      payload: { answerDoc: createTextDocument("bear") }
    });
    expect(response.statusCode).toBe(200);
    expect(sensesCalls).toEqual(["bear"]);
    expect(response.json() as RelatedMaterialSensesResponse).toEqual({
      status: "found",
      surface: "bear",
      senses: [sense]
    });
  });

  it.each(["not_found", "unsupported", "unavailable"] as const)(
    "passes through the %s outcome",
    async (kind) => {
      sensesOutcome = { kind };
      const response = await server.inject({
        method: "POST",
        url: "/api/notes/review/related-material/senses",
        payload: { answerDoc: createTextDocument("bear") }
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as RelatedMaterialSensesResponse).status).toBe(kind);
    }
  );
});

describe("related-material relations route", () => {
  it("rejects a body without a selected sense", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/notes/review/related-material/relations",
      payload: { answerDoc: createTextDocument("bear") }
    });
    expect(response.statusCode).toBe(400);
    expect(relationsCalls).toEqual([]);
  });

  it("relates from the selected sense and enriches each note with its context", async () => {
    await seedAnchoredNote("note-born", "she was born in May");
    relationsOutcome = {
      kind: "found",
      value: {
        surface: "bear",
        selectedLemma: "bear",
        groups: [
          {
            relation: "inflection",
            direction: "lateral",
            source: "morphology",
            notes: [
              { noteEntryId: toEntryId("note-born"), surface: "born" },
              { noteEntryId: toEntryId("note-missing"), surface: "bore" }
            ]
          }
        ]
      }
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/notes/review/related-material/relations",
      payload: {
        answerDoc: createTextDocument("bear"),
        sense: { offset: sense.offset, partOfSpeech: "verb" }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(relationsCalls).toEqual([
      { surface: "bear", sense: { offset: sense.offset, partOfSpeech: "verb" }, userId: DEFAULT_USER_ID }
    ]);
    expect(response.json() as RelatedMaterialRelationsResponse).toEqual({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [
        {
          relation: "inflection",
          direction: "lateral",
          notes: [
            { noteId: "note-born", word: "born", context: "she was born in May" },
            { noteId: "note-missing", word: "bore", context: null }
          ]
        }
      ]
    });
  });

  it("returns an empty found result when no note relates", async () => {
    relationsOutcome = {
      kind: "found",
      value: { surface: "bear", selectedLemma: "bear", groups: [] }
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/notes/review/related-material/relations",
      payload: {
        answerDoc: createTextDocument("bear"),
        sense: { offset: sense.offset, partOfSpeech: "verb" }
      }
    });
    expect((response.json() as RelatedMaterialRelationsResponse)).toEqual({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: []
    });
  });

  it.each(["not_found", "unsupported", "unavailable"] as const)(
    "passes through the %s outcome",
    async (kind) => {
      relationsOutcome = { kind };
      const response = await server.inject({
        method: "POST",
        url: "/api/notes/review/related-material/relations",
        payload: {
          answerDoc: createTextDocument("bear"),
          sense: { offset: sense.offset, partOfSpeech: "verb" }
        }
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as RelatedMaterialRelationsResponse).status).toBe(kind);
    }
  );
});
