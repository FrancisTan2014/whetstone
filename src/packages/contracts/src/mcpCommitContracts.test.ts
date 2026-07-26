import { describe, expect, it } from "vitest";

import {
  COMMIT_CARD_CREATION_TOOL,
  MCP_COMMIT_ID_MAX_LENGTH,
  mcpCommitCardInputSchema,
  mcpCommitCardResultSchema,
  parseMcpCommitCardInput,
  parseMcpCommitCardResult,
  type McpCommitCardResult,
  type McpCommittedCard,
  type McpRefreshedPreview
} from "./mcpCommitContracts.js";

// The MCP commit wire contract (#718). These tests pin the deliberately narrow input surface — the strict
// object carries only the opaque attempt id and one approved decision, never card content — and the
// discriminated result the tool carries. They are the boundary guard: a widened input (smuggled question/
// answer, a revision override, a batch) or a malformed result must fail here, before it reaches the shared
// command.

const committedCard: McpCommittedCard = {
  noteId: "note-1",
  promptId: "prompt-1",
  review: {
    due: "2026-03-01T08:00:00.000Z",
    stability: 1,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: "new",
    lastReviewedAt: null
  }
};

describe("mcpCommitCardInputSchema", () => {
  it("accepts a create decision and normalizes attemptId whitespace", () => {
    const parsed = parseMcpCommitCardInput({
      attemptId: "  attempt-1  ",
      decision: { kind: "create" }
    });
    expect(parsed).toEqual({ attemptId: "attempt-1", decision: { kind: "create" } });
  });

  it("accepts a reuse decision with a note id and a keep_separate decision", () => {
    expect(
      parseMcpCommitCardInput({ attemptId: "a", decision: { kind: "reuse", noteEntryId: "note-9" } })
        .decision
    ).toEqual({ kind: "reuse", noteEntryId: "note-9" });
    expect(
      parseMcpCommitCardInput({ attemptId: "a", decision: { kind: "keep_separate" } }).decision
    ).toEqual({ kind: "keep_separate" });
  });

  it("names the tool it validates", () => {
    expect(COMMIT_CARD_CREATION_TOOL).toBe("commit_card_creation");
  });

  it.each([
    ["missing attemptId", { decision: { kind: "create" } }],
    ["blank attemptId", { attemptId: "   ", decision: { kind: "create" } }],
    [
      "oversized attemptId",
      { attemptId: "z".repeat(MCP_COMMIT_ID_MAX_LENGTH + 1), decision: { kind: "create" } }
    ],
    ["missing decision", { attemptId: "a" }],
    ["unknown decision kind", { attemptId: "a", decision: { kind: "delete" } }],
    ["reuse without a note id", { attemptId: "a", decision: { kind: "reuse" } }],
    ["reuse with a blank note id", { attemptId: "a", decision: { kind: "reuse", noteEntryId: " " } }],
    [
      "reuse with an oversized note id",
      {
        attemptId: "a",
        decision: { kind: "reuse", noteEntryId: "z".repeat(MCP_COMMIT_ID_MAX_LENGTH + 1) }
      }
    ],
    ["smuggled card content", { attemptId: "a", decision: { kind: "create" }, answer: "x" }],
    ["an extra key inside the decision", { attemptId: "a", decision: { kind: "create", noteEntryId: "n" } }],
    ["a batch payload", { attemptId: "a", decision: { kind: "create" }, drafts: [] }],
    ["a non-object decision", { attemptId: "a", decision: "create" }]
  ])("rejects %s", (_label, candidate) => {
    expect(mcpCommitCardInputSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts an attemptId exactly at the length cap", () => {
    const atCap = { attemptId: "a".repeat(MCP_COMMIT_ID_MAX_LENGTH), decision: { kind: "create" } };
    expect(mcpCommitCardInputSchema.safeParse(atCap).success).toBe(true);
  });
});

describe("mcpCommitCardResultSchema", () => {
  it.each(["created", "reused", "kept_separate"] as const)(
    "parses a %s result carrying the committed card",
    (status) => {
      const result = { status, card: committedCard } as McpCommitCardResult;
      expect(parseMcpCommitCardResult(result)).toEqual(result);
    }
  );

  it("parses a needs_approval result carrying the refreshed preview", () => {
    const preview: McpRefreshedPreview = {
      attemptId: "attempt-1",
      expiresAt: "2026-03-01T08:30:00.000Z",
      approvalRequired: true,
      nextAction: "present_preview_and_request_approval",
      renderedCard: { question: "q", answer: "a", successCheck: null },
      candidates: [],
      nearCandidates: [],
      candidateFingerprint: "fp",
      revision: 1
    };
    const result: McpCommitCardResult = { status: "needs_approval", preview };
    expect(parseMcpCommitCardResult(result)).toEqual(result);
  });

  it.each([
    "not_found",
    "expired",
    "candidates_exist",
    "not_a_candidate",
    "no_material",
    "decision_conflict",
    "conflict",
    "gone"
  ] as const)("parses the %s failure outcome", (status) => {
    expect(parseMcpCommitCardResult({ status })).toEqual({ status });
  });

  it("rejects a refreshed preview whose approval gate is not true", () => {
    const bad = {
      status: "needs_approval",
      preview: {
        attemptId: "attempt-1",
        expiresAt: "2026-03-01T08:30:00.000Z",
        approvalRequired: false,
        nextAction: "present_preview_and_request_approval",
        renderedCard: { question: "q", answer: "a", successCheck: null },
        candidates: [],
        nearCandidates: [],
        candidateFingerprint: "fp",
        revision: 1
      }
    };
    expect(mcpCommitCardResultSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a success result missing its card", () => {
    expect(mcpCommitCardResultSchema.safeParse({ status: "created" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(() => parseMcpCommitCardResult({ status: "committed" })).toThrow();
  });
});
