import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { projectNearMatch } from "./nearMatch.js";
import { selectNearMatches } from "./nearMatchRanking.js";

// #713 independent gold corpus gate. `fixtures/card-matching/near-v1.jsonl` carries two complete documents
// and a human-reviewed verdict per row; this test proves the real matcher agrees with EVERY verdict (so a
// mislabeled or false-positive row fails loudly), then measures the holdout gates on the independently
// authored holdout split — precision, in-scope recall, zero false positives per protected/case/lexical guard
// family, and 100% unsupported classification — with per-family counts and a confusion matrix so an aggregate
// number can never hide a family regression. The threshold is fixed in `nearMatchRanking.ts`; if a row ever
// disagrees the fix is the row or the eligibility, never a bar lowered here.

type Verdict = "distinct" | "possible" | "unsupported";

type CorpusRow = Readonly<{
  category: string;
  docA: unknown;
  docB: unknown;
  eligibility: string;
  expected: Verdict;
  family: string;
  id: string;
  protectedEvidence: readonly string[];
  rationale: string;
  split: "calibration" | "holdout";
}>;

function loadCorpus(): CorpusRow[] {
  const path = fileURLToPath(
    new URL("../../../../fixtures/card-matching/near-v1.jsonl", import.meta.url)
  );
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

// Classify one corpus pair exactly as a real single-candidate lookup would: project both documents, treat an
// ineligible document as unsupported, otherwise rank the second against the first and report whether it
// survives as a candidate.
function classify(row: CorpusRow): Verdict {
  const target = projectNearMatch(row.docA);
  const candidate = projectNearMatch(row.docB);
  if (target === null || candidate === null) {
    return "unsupported";
  }
  const matches = selectNearMatches(
    target,
    [{ note: { id: "candidate" }, projection: candidate }],
    (note) => note.id
  );
  return matches.length > 0 ? "possible" : "distinct";
}

const GUARD_FAMILIES = new Set([
  "protected-number",
  "protected-symbol",
  "protected-negation",
  "protected-technical",
  "case-only",
  "lexical-content",
  "lexical-order"
]);

const rows = loadCorpus();
const holdout = rows.filter((row) => row.split === "holdout");

describe("near-v1 corpus shape", () => {
  it("meets the sizes the issue mandates with unique ids and both splits", () => {
    expect(rows.length).toBeGreaterThanOrEqual(500);
    expect(rows.filter((row) => row.expected === "possible").length).toBeGreaterThanOrEqual(150);
    expect(rows.filter((row) => row.expected === "distinct").length).toBeGreaterThanOrEqual(250);
    expect(rows.filter((row) => row.expected === "unsupported").length).toBeGreaterThanOrEqual(100);
    expect(holdout.length).toBeGreaterThanOrEqual(150);
    expect(rows.filter((row) => row.split === "calibration").length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("covers every positive, negative, and unsupported family across both token scales", () => {
    const families = new Set(rows.map((row) => row.family));
    for (const family of [
      "substitution",
      "deletion",
      "insertion",
      "transposition",
      "two-edit",
      "spacing",
      "quote",
      "dash",
      "misspelling",
      "protected-number",
      "protected-symbol",
      "protected-negation",
      "case-only",
      "lexical-content",
      "lexical-order",
      "unsupported-single-word",
      "unsupported-non-ascii",
      "unsupported-cjk",
      "unsupported-emoji",
      "unsupported-link",
      "unsupported-code",
      "unsupported-heading",
      "unsupported-list",
      "unsupported-oversized"
    ]) {
      expect(families.has(family)).toBe(true);
    }
  });
});

describe("near-v1 matcher agreement", () => {
  it("classifies every row exactly as its human-reviewed verdict", () => {
    const mismatches = rows
      .map((row) => ({ actual: classify(row), row }))
      .filter((result) => result.actual !== result.row.expected)
      .map(
        (result) =>
          `${result.row.id} (${result.row.category}): expected ${result.row.expected}, got ${result.actual}`
      );
    expect(mismatches).toEqual([]);
  });
});

describe("near-v1 holdout gates", () => {
  const results = holdout.map((row) => ({ actual: classify(row), row }));
  const inScopePositives = results.filter((result) => result.row.expected === "possible");
  const inScopeNegatives = results.filter((result) => result.row.expected === "distinct");
  const unsupported = results.filter((result) => result.row.expected === "unsupported");
  const predictedPossible = results.filter((result) => result.actual === "possible");
  const truePositives = inScopePositives.filter((result) => result.actual === "possible");
  const falsePositives = predictedPossible.filter((result) => result.row.expected !== "possible");

  it("achieves at least 98% precision on holdout", () => {
    const precision =
      predictedPossible.length === 0 ? 1 : truePositives.length / predictedPossible.length;
    expect(precision).toBeGreaterThanOrEqual(0.98);
  });

  it("achieves at least 90% in-scope recall on holdout", () => {
    const recall =
      inScopePositives.length === 0 ? 1 : truePositives.length / inScopePositives.length;
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(inScopePositives.length).toBeGreaterThan(0);
  });

  it("emits zero false positives for any protected, case, or lexical guard family", () => {
    const byFamily = new Map<string, number>();
    for (const result of inScopeNegatives) {
      expect(GUARD_FAMILIES.has(result.row.family)).toBe(true);
      if (result.actual === "possible") {
        byFamily.set(result.row.family, (byFamily.get(result.row.family) ?? 0) + 1);
      }
    }
    expect([...byFamily.entries()]).toEqual([]);
  });

  it("has at least one holdout row for every guard family it claims to defend", () => {
    const negativeFamilies = new Set(inScopeNegatives.map((result) => result.row.family));
    for (const family of GUARD_FAMILIES) {
      expect(negativeFamilies.has(family)).toBe(true);
    }
  });

  it("classifies 100% of unsupported holdout material as unsupported", () => {
    expect(unsupported.length).toBeGreaterThan(0);
    expect(unsupported.every((result) => result.actual === "unsupported")).toBe(true);
  });

  it("keeps the full confusion matrix on its diagonal within the gates", () => {
    const verdicts: Verdict[] = ["possible", "distinct", "unsupported"];
    const matrix = new Map<string, number>();
    for (const result of results) {
      const key = `${result.row.expected}->${result.actual}`;
      matrix.set(key, (matrix.get(key) ?? 0) + 1);
    }
    const cell = (expected: Verdict, actual: Verdict): number =>
      matrix.get(`${expected}->${actual}`) ?? 0;
    // No in-scope negative or unsupported row may leak into the candidate bucket, and no unsupported row may
    // be treated as an eligible verdict.
    expect(cell("distinct", "possible")).toBe(0);
    expect(cell("unsupported", "possible")).toBe(0);
    expect(cell("unsupported", "distinct")).toBe(0);
    // The reported matrix must account for every holdout row exactly once.
    const total = verdicts.reduce(
      (sum, expected) =>
        sum + verdicts.reduce((inner, actual) => inner + cell(expected, actual), 0),
      0
    );
    expect(total).toBe(holdout.length);
    expect(falsePositives.length).toBe(0);
  });
});
