import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpPreviewCardResult } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import type { LexicalRelationService } from "../features/lexical/lexicalRelationService.js";
import type { PreviewCardCreationDependencies } from "../features/notesReview/previewCardCreation.js";
import { createMcpPreviewServer } from "./mcpServer.js";

const ttlMs = 30 * 60 * 1000;

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

// Connect a real MCP client to the preview server over an in-memory linked transport pair, exercising the true
// initialize/list/call protocol without spawning a process.
async function connect(deps: PreviewCardCreationDependencies): Promise<Client> {
  const server = createMcpPreviewServer({
    preview: deps,
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
  answer: "Merge sort is stable and O(n log n)."
};

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

describe("createMcpPreviewServer", () => {
  it("exposes exactly the preview_card_creation tool", async () => {
    const client = await connect(previewDeps());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["preview_card_creation"]);
    expect(tools[0]!.description).toContain("WRITES NOTHING");
  });

  it("previews a card, returning structured content and a JSON text mirror", async () => {
    const client = await connect(previewDeps());
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
    const client = await connect(previewDeps());
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
    const client = await connect(previewDeps());
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
    const client = await connect(previewDeps());
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
    const client = await connect(previewDeps());
    const result = await client.callTool({ name: "commit_card", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["missing required fields", { requestId: "req-1" }],
    ["a blank question", { ...validArgs, question: "   " }],
    ["an oversized answer", { ...validArgs, answer: "x".repeat(10_001) }],
    ["an unknown field", { ...validArgs, userId: "smuggled" }],
    ["a batch payload", { ...validArgs, drafts: [validArgs] }]
  ])("rejects %s at the input boundary", async (_label, args) => {
    const client = await connect(previewDeps());
    const result = await client.callTool({ name: "preview_card_creation", arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("validation");
    // Boundary rejection stages no learning state and logs nothing.
    expect(logLines).toHaveLength(0);
  });

  it("reports a tool error without leaking internals when the database is unavailable", async () => {
    const brokenDb = {
      transaction: () => Promise.reject(new Error("database is unavailable"))
    } as unknown as DbClient;
    const client = await connect(previewDeps({ db: brokenDb }));

    const result = await client.callTool({ name: "preview_card_creation", arguments: validArgs });
    expect(result.isError).toBe(true);
    const content = result.content as ReadonlyArray<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Card preview is temporarily unavailable.");
    expect(content[0]!.text).not.toContain("database is unavailable");
    expect(logLines.at(-1)).toBe("preview requestId=req-1 status=error");
  });
});
