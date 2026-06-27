import { describe, expect, it } from "vitest";

import {
  authorCaseBriefSchema,
  judgeProductionRequestSchema,
  parseAuthorCaseResult,
  parseProductionJudgement,
  parseProposeNextResult
} from "./coachContracts.js";

describe("parseProductionJudgement", () => {
  const judgement = {
    category: "awkward",
    issues: [{ kind: "word_choice", note: "Missing key words: beans.", severity: "minor" }],
    natural: 0.5
  };

  it("round-trips a valid judgement", () => {
    expect(parseProductionJudgement(judgement)).toEqual(judgement);
  });

  it("rejects a naturalness score outside 0..1", () => {
    expect(() => parseProductionJudgement({ ...judgement, natural: 1.5 })).toThrow();
  });

  it("rejects an unknown category", () => {
    expect(() => parseProductionJudgement({ ...judgement, category: "perfect" })).toThrow();
  });

  it("rejects a blank issue note", () => {
    expect(() =>
      parseProductionJudgement({
        category: "good",
        issues: [{ kind: "grammar", note: "   ", severity: "major" }],
        natural: 1
      })
    ).toThrow();
  });
});

describe("parseProposeNextResult", () => {
  it("round-trips a result, including a null chunk link", () => {
    const result = { chunkId: null, cue: "Say something natural for: dinner", target: "dinner" };
    expect(parseProposeNextResult(result)).toEqual(result);
  });

  it("rejects a blank cue", () => {
    expect(() => parseProposeNextResult({ chunkId: null, cue: "  ", target: "dinner" })).toThrow();
  });
});

describe("parseAuthorCaseResult", () => {
  it("round-trips an authored case and its chunks", () => {
    const result = {
      chunks: [{ gloss: null, text: "Could we talk about dinner?", usageNote: null }],
      communicativeFunction: "Proposing a plan",
      situation: "Planning a meal"
    };
    expect(parseAuthorCaseResult(result)).toEqual(result);
  });

  it("rejects a chunk with blank text", () => {
    expect(() =>
      parseAuthorCaseResult({
        chunks: [{ gloss: null, text: "   ", usageNote: null }],
        communicativeFunction: "f",
        situation: "s"
      })
    ).toThrow();
  });
});

describe("boundary request schemas", () => {
  it("accepts a valid judge-production request", () => {
    const request = {
      context: { focus: "kitchen", recentTargets: ["What's for dinner?"] },
      target: "Help yourself.",
      transcript: "help yourself"
    };
    expect(judgeProductionRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a judge-production request with a blank target", () => {
    expect(() =>
      judgeProductionRequestSchema.parse({
        context: { focus: "", recentTargets: [] },
        target: "  ",
        transcript: "x"
      })
    ).toThrow();
  });

  it("accepts an author-case brief with an optional domain id", () => {
    const brief = {
      communicativeFunction: "Offering food",
      domainId: "kitchen",
      situation: "At the table"
    };
    expect(authorCaseBriefSchema.parse(brief)).toEqual(brief);
  });

  it("rejects an author-case brief with a blank situation", () => {
    expect(() =>
      authorCaseBriefSchema.parse({ communicativeFunction: "f", situation: "  " })
    ).toThrow();
  });
});
