import { describe, expect, it } from "vitest";

import {
  parseEndSessionRequest,
  parseSessionPlanDto,
  parseSessionSummaryDto,
  parseSubmitTurnRequest,
  parseTranscribeRequest,
  parseTurnResultDto
} from "./sessionContracts.js";

describe("parseSubmitTurnRequest", () => {
  it("accepts a typed production", () => {
    const request = { chunkId: "c1", production: { kind: "typed", transcript: "help yourself" } };
    expect(parseSubmitTurnRequest(request)).toEqual(request);
  });

  it("accepts a spoken production", () => {
    const request = { chunkId: "c1", production: { audioPath: "/tmp/a.wav", kind: "spoken" } };
    expect(parseSubmitTurnRequest(request)).toEqual(request);
  });

  it("rejects a blank chunk id", () => {
    expect(() =>
      parseSubmitTurnRequest({ chunkId: "  ", production: { kind: "typed", transcript: "x" } })
    ).toThrow();
  });

  it("rejects a spoken production with a blank audio path", () => {
    expect(() =>
      parseSubmitTurnRequest({ chunkId: "c1", production: { audioPath: " ", kind: "spoken" } })
    ).toThrow();
  });

  it("rejects an unknown production kind", () => {
    expect(() =>
      parseSubmitTurnRequest({ chunkId: "c1", production: { kind: "mimed" } })
    ).toThrow();
  });
});

describe("parseTranscribeRequest", () => {
  it("accepts an audio path", () => {
    expect(parseTranscribeRequest({ audioPath: "/tmp/a.wav" })).toEqual({
      audioPath: "/tmp/a.wav"
    });
  });

  it("rejects a blank audio path", () => {
    expect(() => parseTranscribeRequest({ audioPath: "" })).toThrow();
  });
});

describe("parseEndSessionRequest", () => {
  it("accepts a list of turn records", () => {
    const request = {
      turns: [
        { errorCategory: "register", grade: 3 },
        { errorCategory: null, grade: 5 }
      ]
    };
    expect(parseEndSessionRequest(request)).toEqual(request);
  });

  it("rejects an out-of-range grade", () => {
    expect(() => parseEndSessionRequest({ turns: [{ errorCategory: null, grade: 9 }] })).toThrow();
  });
});

describe("session DTOs", () => {
  it("round-trips a session plan", () => {
    const plan = {
      cues: [
        {
          caseId: "k.meal",
          chunkId: "c1",
          communicativeFunction: "Proposing a plan",
          situation: "Planning a meal",
          target: "What are we having for dinner?",
          timerSeconds: 20
        }
      ]
    };
    expect(parseSessionPlanDto(plan)).toEqual(plan);
  });

  it("round-trips a turn result", () => {
    const result = {
      errorCategory: null,
      grade: 4,
      judgement: { category: "good", issues: [], natural: 1 },
      nextDueAt: "2026-01-02T00:00:00.000Z",
      target: "Help yourself.",
      transcript: "help yourself"
    };
    expect(parseTurnResultDto(result)).toEqual(result);
  });

  it("round-trips a session summary", () => {
    const summary = {
      averageGrade: 3.5,
      errorCounts: [{ category: "article_drop", count: 2 }],
      strongTurns: 1,
      turnCount: 4
    };
    expect(parseSessionSummaryDto(summary)).toEqual(summary);
  });

  it("rejects a session summary with a non-positive error count", () => {
    expect(() =>
      parseSessionSummaryDto({
        averageGrade: 0,
        errorCounts: [{ category: "register", count: 0 }],
        strongTurns: 0,
        turnCount: 0
      })
    ).toThrow();
  });
});
