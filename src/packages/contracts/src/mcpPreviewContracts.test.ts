import { describe, expect, it } from "vitest";

import {
  MCP_PREVIEW_REQUEST_ID_MAX_LENGTH,
  MCP_PREVIEW_TEXT_MAX_LENGTH,
  PREVIEW_CARD_CREATION_TOOL,
  mcpPreviewCardInputSchema,
  mcpPreviewCardResultSchema,
  parseMcpPreviewCardInput,
  parseMcpPreviewCardResult,
  type McpPreviewCardResult
} from "./mcpPreviewContracts.js";

// The MCP preview wire contract (#717). These tests pin the deliberately narrow input surface — the strict
// object rejects anything a preview does not need — and the discriminated result the tool carries. They are
// the boundary guard: a widened input (a batch, a user id, a Note override) or a malformed result must fail
// here, before it reaches the shared command.

const validInput = {
  requestId: "req-1",
  question: "Which sorting algorithm is stable?",
  answer: "Merge sort is stable."
};

describe("mcpPreviewCardInputSchema", () => {
  it("accepts a minimal question/answer draft and normalizes requestId whitespace", () => {
    const parsed = parseMcpPreviewCardInput({ ...validInput, requestId: "  req-1  " });
    expect(parsed).toEqual(validInput);
    expect(parsed.successCheck).toBeUndefined();
    expect(parsed.sense).toBeUndefined();
  });

  it("accepts an optional success check and an explicit sense reference", () => {
    const parsed = parseMcpPreviewCardInput({
      ...validInput,
      successCheck: "Names merge sort and its stability.",
      sense: { offset: "01234567", partOfSpeech: "noun" }
    });
    expect(parsed.successCheck).toBe("Names merge sort and its stability.");
    expect(parsed.sense).toEqual({ offset: "01234567", partOfSpeech: "noun" });
  });

  it("names the single tool it validates", () => {
    expect(PREVIEW_CARD_CREATION_TOOL).toBe("preview_card_creation");
  });

  it.each([
    ["missing requestId", { question: "q", answer: "a" }],
    ["blank requestId", { ...validInput, requestId: "   " }],
    ["blank question", { ...validInput, question: "   " }],
    ["blank answer", { ...validInput, answer: "\n\t " }],
    ["blank success check", { ...validInput, successCheck: "  " }],
    ["oversized answer", { ...validInput, answer: "x".repeat(MCP_PREVIEW_TEXT_MAX_LENGTH + 1) }],
    [
      "oversized question",
      { ...validInput, question: "y".repeat(MCP_PREVIEW_TEXT_MAX_LENGTH + 1) }
    ],
    [
      "oversized requestId",
      { ...validInput, requestId: "z".repeat(MCP_PREVIEW_REQUEST_ID_MAX_LENGTH + 1) }
    ],
    ["unknown key", { ...validInput, userId: "smuggled" }],
    ["batch payload", { ...validInput, drafts: [validInput] }],
    ["malformed sense", { ...validInput, sense: { offset: "01234567" } }],
    ["non-string answer", { ...validInput, answer: 42 }]
  ])("rejects %s", (_label, candidate) => {
    expect(mcpPreviewCardInputSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts an answer exactly at the length cap and rejects one past it", () => {
    const atCap = { ...validInput, answer: "a".repeat(MCP_PREVIEW_TEXT_MAX_LENGTH) };
    expect(mcpPreviewCardInputSchema.safeParse(atCap).success).toBe(true);
  });
});

describe("mcpPreviewCardResultSchema", () => {
  const previewed: McpPreviewCardResult = {
    status: "previewed",
    attemptId: "attempt-1",
    expiresAt: "2026-03-01T08:30:00.000Z",
    approvalRequired: true,
    nextAction: "present_preview_and_request_approval",
    renderedCard: { question: "q", answer: "a", successCheck: null },
    candidates: [],
    nearCandidates: [],
    candidateFingerprint: "fp",
    revision: 0,
    relatedMaterial: { mode: "senses", senses: { status: "not_found" } }
  };

  it("parses a previewed result with senses evidence", () => {
    expect(parseMcpPreviewCardResult(previewed)).toEqual(previewed);
  });

  it("parses a previewed result carrying relations evidence and a success check", () => {
    const withRelations: McpPreviewCardResult = {
      ...previewed,
      renderedCard: { question: "q", answer: "a", successCheck: "check" },
      relatedMaterial: {
        mode: "relations",
        relations: {
          status: "found",
          surface: "bear",
          selectedLemma: "bear",
          partOfSpeech: "verb",
          groups: []
        }
      }
    };
    expect(parseMcpPreviewCardResult(withRelations)).toEqual(withRelations);
  });

  it.each([
    "invalid_question",
    "invalid_answer",
    "invalid_success_check",
    "changed_payload"
  ] as const)("parses the %s outcome", (status) => {
    expect(parseMcpPreviewCardResult({ status })).toEqual({ status });
  });

  it("rejects a previewed result whose approval gate is not true", () => {
    expect(
      mcpPreviewCardResultSchema.safeParse({ ...previewed, approvalRequired: false }).success
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(() => parseMcpPreviewCardResult({ status: "committed" })).toThrow();
  });
});
