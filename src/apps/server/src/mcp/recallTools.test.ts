import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyRating, newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { entries } from "../db/schema.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { callRecallTool, createRecallMcpServer, type RecallMcpContext } from "./recallTools.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

type Ctx = Readonly<{ context: RecallMcpContext; db: DbClient }>;
let ctx: Ctx;

async function buildCtx(): Promise<Ctx> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  let sequence = 0;
  const context: RecallMcpContext = {
    currentUser: createDefaultCurrentUserProvider(),
    dueLimit: 20,
    now: () => t0,
    memory: { createId: () => `id-${(sequence += 1)}`, db }
  };
  return { context, db };
}

function dataOf(result: Awaited<ReturnType<typeof callRecallTool>>): unknown {
  const first = result.content[0] as { text: string };
  return JSON.parse(first.text);
}

function textOf(result: Awaited<ReturnType<typeof callRecallTool>>): string {
  return (result.content[0] as { text: string }).text;
}

async function depositScheduled(
  cueText: string,
  answerText = `answer for ${cueText}`
): Promise<{
  noteId: string;
  promptId: string;
}> {
  const deposit = dataOf(
    await callRecallTool(ctx.context, "deposit_memory", {
      captureSource: "manual",
      noteText: answerText,
      prompts: [{ answerText, cueText }]
    })
  ) as {
    note: { noteId: string };
    prompts: ReadonlyArray<{ promptId: string }>;
  };
  return { noteId: deposit.note.noteId, promptId: deposit.prompts[0]?.promptId ?? "" };
}

beforeEach(async () => {
  ctx = await buildCtx();
});

afterEach(async () => {
  await ctx.db.$client.close();
});

describe("callRecallTool", () => {
  it("deposits scheduled, draft, and gloss-resolved Memory prompts", async () => {
    await ctx.db.insert(entries).values({ id: "block-1", type: "block" });
    const context: RecallMcpContext = {
      ...ctx.context,
      memory: {
        ...ctx.context.memory,
        resolveOfflineGloss: async (term) => (term === "mitigation" ? "risk reduction" : null)
      }
    };

    const saved = dataOf(
      await callRecallTool(context, "deposit_memory", {
        captureSource: "reader",
        derivedFromEntryId: "block-1",
        noteText: "remember mitigation",
        prompts: [
          { answerText: "risk reduction", cueText: "mitigation" },
          { cueText: "answer later" },
          { cueText: "dictionary-backed", glossTerm: "mitigation" }
        ]
      })
    ) as {
      note: { bodyText: string; captureSource: string; derivedFromEntryId: string; noteId: string };
      prompts: ReadonlyArray<{
        answerText: string | null;
        chunkId: string | null;
        cueText: string;
        lifecycle: string;
        noteId: string;
        promptId: string;
        review: { due: string } | null;
      }>;
    };

    expect(saved.note).toMatchObject({
      bodyText: "remember mitigation",
      captureSource: "reader",
      derivedFromEntryId: "block-1",
      noteId: "id-1"
    });
    expect(saved.prompts).toHaveLength(3);
    expect(saved.prompts[0]).toMatchObject({
      answerText: "risk reduction",
      chunkId: null,
      cueText: "mitigation",
      lifecycle: "ready",
      noteId: "id-1",
      promptId: "id-2",
      review: { due: t0.toISOString() }
    });
    expect(saved.prompts[1]).toMatchObject({
      answerText: null,
      cueText: "answer later",
      lifecycle: "draft",
      review: null
    });
    expect(saved.prompts[2]).toMatchObject({
      answerText: "risk reduction",
      cueText: "dictionary-backed",
      lifecycle: "ready",
      review: { due: t0.toISOString() }
    });
  });

  it("lists due prompts with the default cap and an explicit limit", async () => {
    await depositScheduled("first");
    await depositScheduled("second");

    const allDue = dataOf(await callRecallTool(ctx.context, "list_due_prompts", {})) as {
      items: ReadonlyArray<{ cueText: string; promptId: string }>;
    };
    expect(allDue.items.map((item) => item.cueText)).toEqual(["first", "second"]);

    const limited = dataOf(await callRecallTool(ctx.context, "list_due_prompts", { limit: 1 })) as {
      items: ReadonlyArray<{ cueText: string }>;
    };
    expect(limited.items).toEqual([expect.objectContaining({ cueText: "first" })]);
  });

  it("records a scheduled prompt review and removes it from today's due list", async () => {
    const { promptId } = await depositScheduled("spill the beans", "reveal a secret");

    const expected = applyRating(newReviewState(t0), "good", t0, RECALL_REQUEST_RETENTION);
    const reviewed = dataOf(
      await callRecallTool(ctx.context, "record_review", { promptId, rating: "good" })
    ) as { review: { due: string; reps: number; state: string } };
    expect(reviewed.review).toEqual(expected);
    expect(reviewed.review).toMatchObject({ reps: 1, state: "learning" });

    const dueAfter = dataOf(await callRecallTool(ctx.context, "list_due_prompts", {})) as {
      items: ReadonlyArray<unknown>;
    };
    expect(dueAfter.items).toEqual([]);
  });

  it("returns clean record_review errors for missing and draft prompts", async () => {
    const missing = await callRecallTool(ctx.context, "record_review", {
      promptId: "nope",
      rating: "good"
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Cannot review prompt nope: not_found.");

    const deposit = dataOf(
      await callRecallTool(ctx.context, "deposit_memory", {
        captureSource: "manual",
        noteText: "draft only",
        prompts: [{ cueText: "no answer yet" }]
      })
    ) as { prompts: ReadonlyArray<{ promptId: string }> };
    const draftId = deposit.prompts[0]?.promptId ?? "";
    const draft = await callRecallTool(ctx.context, "record_review", {
      promptId: draftId,
      rating: "good"
    });
    expect(draft.isError).toBe(true);
    expect(textOf(draft)).toContain(`Cannot review prompt ${draftId}: not_scheduled.`);
  });

  it("searches Memory prompts by cue or answer and returns an empty result for misses", async () => {
    const { promptId } = await depositScheduled("spill the beans", "reveal a secret");

    const byCue = dataOf(
      await callRecallTool(ctx.context, "search_memory", { query: "beans" })
    ) as {
      items: ReadonlyArray<{ promptId: string }>;
    };
    expect(byCue.items.map((item) => item.promptId)).toEqual([promptId]);

    const byAnswer = dataOf(
      await callRecallTool(ctx.context, "search_memory", { query: "secret" })
    ) as { items: ReadonlyArray<{ promptId: string }> };
    expect(byAnswer.items.map((item) => item.promptId)).toEqual([promptId]);

    const empty = dataOf(
      await callRecallTool(ctx.context, "search_memory", { query: "absent" })
    ) as {
      items: ReadonlyArray<unknown>;
    };
    expect(empty.items).toEqual([]);
  });

  it("fetches a Memory prompt by id and returns a clean not-found error", async () => {
    const { promptId } = await depositScheduled("by and large", "generally");

    const fetched = dataOf(
      await callRecallTool(ctx.context, "get_memory_prompt", { promptId })
    ) as { answerText: string; cueText: string; promptId: string };
    expect(fetched).toMatchObject({ answerText: "generally", cueText: "by and large", promptId });

    const missing = await callRecallTool(ctx.context, "get_memory_prompt", { promptId: "missing" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("No memory prompt with id missing.");
  });

  it("returns clean errors for unknown tools and invalid inputs", async () => {
    const unknown = await callRecallTool(ctx.context, "no_such_tool", {});
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown tool: no_such_tool");

    for (const [name, args] of [
      ["deposit_memory", { captureSource: "manual", noteText: " ", prompts: [] }],
      ["list_due_prompts", { limit: 0 }],
      ["record_review", { promptId: " ", rating: "good" }],
      ["search_memory", { query: "x", extra: true }],
      ["get_memory_prompt", "not-an-object"]
    ] as const) {
      const result = await callRecallTool(ctx.context, name, args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid arguments");
    }
  });
});

describe("createRecallMcpServer", () => {
  it("advertises the memory tools and serves calls end-to-end over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createRecallMcpServer(ctx.context);
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "deposit_memory",
        "get_memory_prompt",
        "list_due_prompts",
        "record_review",
        "search_memory"
      ]);

      const saved = await client.callTool({
        arguments: {
          captureSource: "manual",
          noteText: "MCP note",
          prompts: [{ answerText: "MCP answer", cueText: "MCP cue" }]
        },
        name: "deposit_memory"
      });
      const deposit = JSON.parse((saved.content as Array<{ text: string }>)[0]?.text ?? "{}") as {
        prompts: ReadonlyArray<{ cueText: string; promptId: string }>;
      };
      expect(deposit.prompts[0]).toMatchObject({ cueText: "MCP cue", promptId: "id-2" });

      const invalid = await client.callTool({ arguments: {}, name: "get_memory_prompt" });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
