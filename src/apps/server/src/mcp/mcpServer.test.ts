import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpCommitCardResult, McpPreviewCardResult } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultCurrentUserProvider, DEFAULT_USER_ID } from "../identity/currentUser.js";
import type { LexicalRelationService } from "../features/lexical/lexicalRelationService.js";
import type { CommitCardCreationDependencies } from "../features/notesReview/commitCardCreation.js";
import {
  createDirectCard,
  type CreateDirectCardDependencies
} from "../features/notesReview/createDirectCard.js";
import type { PreviewCardCreationDependencies } from "../features/notesReview/previewCardCreation.js";
import { createMcpCardServer } from "./mcpServer.js";

const ttlMs = 30 * 60 * 1000;
const answerA = "Merge sort is stable and O(n log n).";

let db: DbClient;
let sequence: number;
let logLines: string[];

const fakeLexical: LexicalRelationService = {
  resolveSenses: async () => ({ kind: "not_found" }),
  relateNotes: async () => ({ kind: "not_found" })
};

function previewDeps(
  over: Partial<PreviewCardCreationDependencies> = {}
): PreviewCardCreationDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `attempt-${(sequence += 1)}`,
    db,
    lexical: fakeLexical,
    now: () => new Date("2026-03-01T08:00:00.000Z"),
    ...over
  };
}

function commitDeps(over: Partial<CommitCardCreationDependencies> = {}): CommitCardCreationDependencies {
  return {
    createId: () => `card-${(sequence += 1)}`,
    db,
    now: () => new Date("2026-03-01T08:00:00.000Z"),
    ...over
  };
}

function directCardDeps(): CreateDirectCardDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `seed-${(sequence += 1)}`,
    db,
    now: () => new Date("2026-03-01T08:00:00.000Z")
  };
}

async function seedMaterial(answer: string, submissionId: string): Promise<string> {
  const result = await createDirectCard(directCardDeps(), DEFAULT_USER_ID, {
    submissionId,
    questionDoc: createTextDocument("Seed question?"),
    answerDoc: createTextDocument(answer),
    target: { kind: "current_note" }
  });
  if (result.status !== "created") throw new Error(`expected seeded card, got ${result.status}`);
  return result.result.noteId;
}

// Connect a real MCP client to the card server over an in-memory linked transport pair, exercising the true
// initialize/list/call protocol without spawning a process.
async function connect(
  over: {
    preview?: Partial<PreviewCardCreationDependencies>;
    commit?: Partial<CommitCardCreationDependencies>;
  } = {}
): Promise<Client> {
  const server = createMcpCardServer({
    preview: previewDeps(over.preview),
    commit: commitDeps(over.commit),
    currentUser: createDefaultCurrentUserProvider(),
    log: (line) => logLines.push(line)
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const validArgs = {
  requestId: "req-1",
  question: "Which sorting algorithm is stable?",
  answer: answerA
};

// Preview through the client and return the staged opaque attempt id.
async function stage(
  client: Client,
  args: Record<string, unknown> = validArgs
): Promise<string> {
  const result = await client.callTool({ name: "preview_card_creation", arguments: args });
  const structured = result.structuredContent as McpPreviewCardResult;
  if (structured.status !== "previewed") throw new Error(`expected previewed, got ${structured.status}`);
  return structured.attemptId;
}

async function callCommit(
  client: Client,
  attemptId: string,
  decision: unknown
): Promise<McpCommitCardResult> {
  const result = await client.callTool({
    name: "commit_card_creation",
    arguments: { attemptId, decision }
  });
  return result.structuredContent as McpCommitCardResult;
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  sequence = 0;
  logLines = [];
});

afterEach(() => {
  // Per-test PGlite + in-memory transports are garbage-collected; nothing to close explicitly.
});

describe("createMcpCardServer", () => {
  it("exposes exactly the preview and commit card tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "commit_card_creation",
      "preview_card_creation"
    ]);
    const commit = tools.find((tool) => tool.name === "commit_card_creation");
    expect(commit!.description).toContain("explicitly approved by the learner");
  });

  it("previews a card, returning structured content and a JSON text mirror", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "preview_card_creation", arguments: validArgs });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as McpPreviewCardResult;
    expect(structured.status).toBe("previewed");
    if (structured.status !== "previewed") throw new Error("expected previewed");
    expect(structured.approvalRequired).toBe(true);
    expect(structured.renderedCard.answer).toBe(validArgs.answer);

    // The text content mirrors the structured content exactly.
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(structured);

    // The safe log line carries ids/counts only — never the card text.
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("status=previewed");
    expect(logLines[0]).not.toContain(validArgs.answer);
  });

  it("wraps an optional success check and an explicit sense into the preview", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "preview_card_creation",
      arguments: {
        ...validArgs,
        successCheck: "Names merge sort and its stability.",
        sense: { offset: "02133435", partOfSpeech: "noun" }
      }
    });
    const structured = result.structuredContent as McpPreviewCardResult;
    if (structured.status !== "previewed") throw new Error("expected previewed");
    expect(structured.renderedCard.successCheck).toBe("Names merge sort and its stability.");
    expect(structured.relatedMaterial.mode).toBe("relations");
  });

  it("logs a content-free line for a changed_payload conflict", async () => {
    const client = await connect();
    await client.callTool({ name: "preview_card_creation", arguments: validArgs });
    const conflict = await client.callTool({
      name: "preview_card_creation",
      arguments: { ...validArgs, answer: "A different answer entirely." }
    });
    const structured = conflict.structuredContent as McpPreviewCardResult;
    expect(structured.status).toBe("changed_payload");
    expect(logLines.at(-1)).toBe("preview requestId=req-1 status=changed_payload");
  });

  it("round-trips Unicode/CJK/emoji plain text without breaking serialization", async () => {
    const client = await connect();
    const unicode = {
      requestId: "req-unicode",
      question: "「安定ソート」とは？ 🤔",
      answer: "マージソートは安定 ✅ 稳定排序 — stable, O(n log n)."
    };
    const result = await client.callTool({ name: "preview_card_creation", arguments: unicode });
    const structured = result.structuredContent as McpPreviewCardResult;
    if (structured.status !== "previewed") throw new Error("expected previewed");
    expect(structured.renderedCard.question).toBe(unicode.question);
    expect(structured.renderedCard.answer).toBe(unicode.answer);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(structured);
  });

  it("returns a tool error for an unknown tool", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "commit_card", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["missing required fields", { requestId: "req-1" }],
    ["a blank question", { ...validArgs, question: "   " }],
    ["an oversized answer", { ...validArgs, answer: "x".repeat(10_001) }],
    ["an unknown field", { ...validArgs, userId: "smuggled" }],
    ["a batch payload", { ...validArgs, drafts: [validArgs] }]
  ])("rejects a preview with %s at the input boundary", async (_label, args) => {
    const client = await connect();
    const result = await client.callTool({ name: "preview_card_creation", arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("validation");
    // Boundary rejection stages no learning state and logs nothing.
    expect(logLines).toHaveLength(0);
  });

  it("reports a tool error without leaking internals when the preview database is unavailable", async () => {
    const brokenDb = {
      transaction: () => Promise.reject(new Error("database is unavailable"))
    } as unknown as DbClient;
    const client = await connect({ preview: { db: brokenDb } });

    const result = await client.callTool({ name: "preview_card_creation", arguments: validArgs });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Card preview is temporarily unavailable.");
    expect(content[0]!.text).not.toContain("database is unavailable");
    expect(logLines.at(-1)).toBe("preview requestId=req-1 status=error");
  });

  it("commits an approved no-candidate draft, mirroring structured content and logging ids only", async () => {
    const client = await connect();
    const attemptId = await stage(client);
    const result = await client.callTool({
      name: "commit_card_creation",
      arguments: { attemptId, decision: { kind: "create" } }
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as McpCommitCardResult;
    expect(structured.status).toBe("created");
    if (structured.status !== "created") throw new Error("expected created");
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(structured);

    // The commit log carries ids/status only — never card text.
    const line = logLines.at(-1)!;
    expect(line).toContain("status=created");
    expect(line).toContain(`attemptId=${attemptId}`);
    expect(line).toContain(`noteId=${structured.card.noteId}`);
    expect(line).not.toContain(answerA);
  });

  it("logs a reused commit's ids", async () => {
    const client = await connect();
    const seededId = await seedMaterial(answerA, "seed-reuse");
    const attemptId = await stage(client, { ...validArgs, successCheck: "Recalls stability." });
    const result = await callCommit(client, attemptId, { kind: "reuse", noteEntryId: seededId });
    expect(result.status).toBe("reused");
    expect(logLines.at(-1)).toContain("status=reused");
  });

  it("logs a kept_separate commit's ids", async () => {
    const client = await connect();
    await seedMaterial(answerA, "seed-keep");
    const attemptId = await stage(client);
    const result = await callCommit(client, attemptId, { kind: "keep_separate" });
    expect(result.status).toBe("kept_separate");
    expect(logLines.at(-1)).toContain("status=kept_separate");
  });

  it("returns and logs a refreshed preview when candidates appear after approval", async () => {
    const client = await connect();
    const attemptId = await stage(client);
    await seedMaterial(answerA, "seed-late");
    const result = await callCommit(client, attemptId, { kind: "create" });

    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") throw new Error("expected needs_approval");
    expect(result.preview.candidates).toHaveLength(1);
    expect(logLines.at(-1)).toBe(`commit attemptId=${attemptId} status=needs_approval exact=1 near=0`);
  });

  it("logs a content-free line for a not_found commit", async () => {
    const client = await connect();
    const result = await callCommit(client, "attempt-missing", { kind: "create" });
    expect(result).toEqual({ status: "not_found" });
    expect(logLines.at(-1)).toBe("commit attemptId=attempt-missing status=not_found");
  });

  it.each([
    ["missing the decision", { attemptId: "a" }],
    ["an unknown decision kind", { attemptId: "a", decision: { kind: "delete" } }],
    ["smuggled card content", { attemptId: "a", decision: { kind: "create" }, answer: "x" }],
    ["a reuse without a note id", { attemptId: "a", decision: { kind: "reuse" } }]
  ])("rejects a commit with %s at the input boundary", async (_label, args) => {
    const client = await connect();
    const result = await client.callTool({ name: "commit_card_creation", arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("validation");
  });

  it("reports a tool error without leaking internals when the commit database is unavailable", async () => {
    const brokenDb = {
      transaction: () => {
        throw new Error("database is unavailable");
      },
      select: () => {
        throw new Error("database is unavailable");
      }
    } as unknown as DbClient;
    const client = await connect({ commit: { db: brokenDb } });

    const result = await client.callTool({
      name: "commit_card_creation",
      arguments: { attemptId: "attempt-1", decision: { kind: "create" } }
    });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Card commit is temporarily unavailable.");
    expect(content[0]!.text).not.toContain("database is unavailable");
    expect(logLines.at(-1)).toBe("commit attemptId=attempt-1 status=error");
  });
});
