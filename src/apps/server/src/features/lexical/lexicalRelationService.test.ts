import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import type { LexicalLemmatizer } from "./lexicalLemmatizer.js";
import { createLexicalRelationService } from "./lexicalRelationService.js";
import type { LexicalNoteReader } from "./lexicalNoteQuery.js";
import type { LexicalRawSynset, LexicalWordNet } from "./wordnetLexicalProvider.js";

// #715 orchestration. The service maps a surface + selected sense onto the four-outcome union. These tests
// drive each outcome for both operations with in-memory WordNet fakes: unsupported (ineligible surface),
// not_found (no sense / a sense the surface does not belong to), unavailable (a WordNet failure — never
// silence), and found. A database read error is proven to propagate rather than masquerade as unavailable.

const echoLemmatize: LexicalLemmatizer = (surface) => surface.toLowerCase();

const CAR: LexicalRawSynset = {
  synsetOffset: "car1",
  pos: "n",
  synonyms: ["car", "auto"],
  definition: "a motor vehicle",
  examples: [],
  pointers: []
};

const foundWordNet: LexicalWordNet = {
  lookup: (surface) => Promise.resolve(surface === "car" ? [CAR] : []),
  seek: (offset, pos) => Promise.resolve(offset === "car1" && pos === "n" ? CAR : null)
};

const emptyWordNet: LexicalWordNet = {
  lookup: () => Promise.resolve([]),
  seek: () => Promise.resolve(null)
};

const throwingWordNet: LexicalWordNet = {
  lookup: () => Promise.reject(new Error("unreadable")),
  seek: () => Promise.reject(new Error("unreadable"))
};

let db: DbClient;

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("resolveSenses", () => {
  it("reports unsupported for an ineligible surface", async () => {
    const service = createLexicalRelationService({
      wordnet: foundWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.resolveSenses("ice cream")).toEqual({ kind: "unsupported" });
  });

  it("reports not_found for an eligible surface with no WordNet sense", async () => {
    const service = createLexicalRelationService({
      wordnet: emptyWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.resolveSenses("frobnicate")).toEqual({ kind: "not_found" });
  });

  it("reports unavailable when WordNet cannot be read", async () => {
    const service = createLexicalRelationService({
      wordnet: throwingWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.resolveSenses("car")).toEqual({ kind: "unavailable" });
  });

  it("returns the deduped senses for an eligible surface", async () => {
    const service = createLexicalRelationService({
      wordnet: foundWordNet,
      lemmatize: echoLemmatize
    });
    const outcome = await service.resolveSenses("Car");
    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") {
      return;
    }
    expect(outcome.value.surface).toBe("car");
    expect(outcome.value.senses.map((sense) => sense.offset)).toEqual(["car1"]);
  });
});

describe("relateNotes", () => {
  const senseRef = { offset: "car1", partOfSpeech: "noun" } as const;
  const params = { userId: "user-1" } as const;

  it("reports unsupported for an ineligible surface", async () => {
    const service = createLexicalRelationService({
      wordnet: foundWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.relateNotes(db, "ice cream", senseRef, params)).toEqual({
      kind: "unsupported"
    });
  });

  it("reports not_found when the surface does not belong to the selected sense", async () => {
    const service = createLexicalRelationService({
      wordnet: emptyWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.relateNotes(db, "car", senseRef, params)).toEqual({ kind: "not_found" });
  });

  it("reports unavailable when WordNet cannot be read", async () => {
    const service = createLexicalRelationService({
      wordnet: throwingWordNet,
      lemmatize: echoLemmatize
    });
    expect(await service.relateNotes(db, "car", senseRef, params)).toEqual({ kind: "unavailable" });
  });

  it("resolves the selected sense and returns owner-scoped groups", async () => {
    const service = createLexicalRelationService({
      wordnet: foundWordNet,
      lemmatize: echoLemmatize
    });
    const outcome = await service.relateNotes(db, "car", senseRef, params);
    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") {
      return;
    }
    expect(outcome.value.surface).toBe("car");
    expect(outcome.value.selectedLemma).toBe("car");
    // No notes seeded, so no groups — but the outcome is a resolved `found`, never a failure.
    expect(outcome.value.groups).toEqual([]);
  });

  it("propagates a database read error instead of reporting unavailable", async () => {
    const service = createLexicalRelationService({
      wordnet: foundWordNet,
      lemmatize: echoLemmatize
    });
    const failingReader = {
      select: () => {
        throw new Error("db down");
      }
    } as unknown as LexicalNoteReader;
    await expect(service.relateNotes(failingReader, "car", senseRef, params)).rejects.toThrow(
      "db down"
    );
  });
});
