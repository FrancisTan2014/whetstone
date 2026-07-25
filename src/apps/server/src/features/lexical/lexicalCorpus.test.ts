import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import WordPOS from "wordpos";
import { describe, expect, it } from "vitest";

import {
  lexicalRelationFacet,
  normalizeLexicalSurface,
  type LexicalPartOfSpeech,
  type LexicalRelationType
} from "@whetstone/domain";

import { winkLemmatizer } from "./lexicalLemmatizer.js";
import { createLexicalRelationService } from "./lexicalRelationService.js";
import {
  classifyContextRelation,
  createWordNetLexical,
  resolveSenseRelations,
  type WordPosSeekLike
} from "./wordnetLexicalProvider.js";

// #715 independent gold-corpus gate. `fixtures/card-matching/lexical-v1.jsonl` carries a human-authored
// verdict per row across three concerns — a typed one-hop relation (or a deliberate silence), a polysemy
// case that must never auto-select, and an unsupported/out-of-vocabulary surface. This test runs the REAL
// offline service (bundled WordNet + wink-lemmatizer) and proves it agrees with EVERY row, then measures the
// holdout gates on the independently authored holdout split: typed-relation precision and zero silent
// (false) selections on the negative and unsupported guards. When a row disagrees the fix is the row or the
// eligibility, never a bar lowered here.

type RelationRow = Readonly<{
  id: string;
  split: "calibration" | "holdout";
  kind: "relation";
  category: string;
  surface: string;
  pos: LexicalPartOfSpeech;
  senseOffset: string;
  existing: string;
  relation: LexicalRelationType | null;
  direction: string | null;
}>;

type AmbiguityRow = Readonly<{
  id: string;
  split: "calibration" | "holdout";
  kind: "ambiguity";
  category: string;
  surface: string;
  minSenses: number;
}>;

type UnsupportedRow = Readonly<{
  id: string;
  split: "calibration" | "holdout";
  kind: "unsupported";
  category: string;
  surface: string;
  outcome: "unsupported" | "not_found";
}>;

type CorpusRow = RelationRow | AmbiguityRow | UnsupportedRow;

function loadCorpus(): CorpusRow[] {
  const path = fileURLToPath(
    new URL("../../../../../../fixtures/card-matching/lexical-v1.jsonl", import.meta.url)
  );
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

const wordnet = createWordNetLexical(new WordPOS() as unknown as WordPosSeekLike);
const service = createLexicalRelationService({ wordnet, lemmatize: winkLemmatizer });

// Classify a relation row exactly as the note query would: resolve the caller-selected sense, then type the
// existing surface against it. Returns the typed relation or null (a deliberate silence).
async function classifyRelation(row: RelationRow): Promise<LexicalRelationType | null> {
  const surfaceKey = normalizeLexicalSurface(row.surface);
  const existingKey = normalizeLexicalSurface(row.existing);
  if (surfaceKey === null || existingKey === null) {
    return null;
  }
  const context = await resolveSenseRelations(
    wordnet,
    surfaceKey,
    { offset: row.senseOffset, partOfSpeech: row.pos },
    winkLemmatizer
  );
  if (context === null) {
    return null;
  }
  return classifyContextRelation(context, existingKey, winkLemmatizer);
}

const RELATION_FAMILIES: readonly LexicalRelationType[] = [
  "inflection",
  "synonym",
  "antonym",
  "derivation",
  "hypernym",
  "hyponym"
];

const rows = loadCorpus();
const relationRows = rows.filter((row): row is RelationRow => row.kind === "relation");
const ambiguityRows = rows.filter((row): row is AmbiguityRow => row.kind === "ambiguity");
const unsupportedRows = rows.filter((row): row is UnsupportedRow => row.kind === "unsupported");
const positives = relationRows.filter((row) => row.relation !== null);
const negatives = relationRows.filter((row) => row.relation === null);
const holdout = rows.filter((row) => row.split === "holdout");

describe("lexical-v1 corpus shape", () => {
  it("meets the sizes the issue mandates with unique ids and both splits", () => {
    expect(rows.length).toBeGreaterThanOrEqual(300);
    expect(positives.length).toBeGreaterThanOrEqual(100);
    expect(ambiguityRows.length).toBeGreaterThanOrEqual(100);
    expect(unsupportedRows.length + negatives.length).toBeGreaterThanOrEqual(100);
    expect(holdout.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.split === "calibration").length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("covers every relation family in the positives and in the holdout split", () => {
    const positiveFamilies = new Set(positives.map((row) => row.relation));
    const holdoutFamilies = new Set(
      positives.filter((row) => row.split === "holdout").map((row) => row.relation)
    );
    for (const family of RELATION_FAMILIES) {
      expect(positiveFamilies.has(family)).toBe(true);
      expect(holdoutFamilies.has(family)).toBe(true);
    }
  });

  it("keeps every relation row's declared direction consistent with its relation", () => {
    for (const row of positives) {
      expect(row.relation).not.toBeNull();
      if (row.relation !== null) {
        expect(row.direction).toBe(lexicalRelationFacet(row.relation).direction);
      }
    }
  });
});

describe("lexical-v1 service agreement", () => {
  it("types every relation row exactly as its authored verdict", async () => {
    const mismatches: string[] = [];
    for (const row of relationRows) {
      const actual = await classifyRelation(row);
      if (actual !== row.relation) {
        mismatches.push(`${row.id} (${row.category}): expected ${row.relation}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("never auto-selects a sense and always offers at least the declared polysemy", async () => {
    const mismatches: string[] = [];
    for (const row of ambiguityRows) {
      const outcome = await service.resolveSenses(row.surface);
      if (outcome.kind !== "found" || outcome.value.senses.length < row.minSenses) {
        const count = outcome.kind === "found" ? outcome.value.senses.length : outcome.kind;
        mismatches.push(`${row.id}: expected >= ${row.minSenses} senses, got ${count}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("classifies every unsupported/out-of-vocabulary row to its outcome", async () => {
    const mismatches: string[] = [];
    for (const row of unsupportedRows) {
      const outcome = await service.resolveSenses(row.surface);
      if (outcome.kind !== row.outcome) {
        mismatches.push(
          `${row.id} (${row.category}): expected ${row.outcome}, got ${outcome.kind}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe("lexical-v1 holdout gates", () => {
  it("achieves at least 95% typed-relation precision on holdout", async () => {
    const holdoutRelations = relationRows.filter((row) => row.split === "holdout");
    let predicted = 0;
    let correct = 0;
    for (const row of holdoutRelations) {
      const actual = await classifyRelation(row);
      if (actual !== null) {
        predicted += 1;
        if (actual === row.relation) {
          correct += 1;
        }
      }
    }
    expect(predicted).toBeGreaterThan(0);
    const precision = correct / predicted;
    expect(precision).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it("emits zero silent (false) selections on holdout negative and unsupported guards", async () => {
    const leaks: string[] = [];
    for (const row of negatives.filter((candidate) => candidate.split === "holdout")) {
      const actual = await classifyRelation(row);
      if (actual !== null) {
        leaks.push(`${row.id}: false relation ${actual}`);
      }
    }
    for (const row of unsupportedRows.filter((candidate) => candidate.split === "holdout")) {
      const outcome = await service.resolveSenses(row.surface);
      if (outcome.kind === "found") {
        leaks.push(`${row.id}: unexpected senses for unsupported surface`);
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);
});
