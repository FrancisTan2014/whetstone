import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultCurrentUserProvider } from "../identity/currentUser.js";
import { callRecallTool, createRecallMcpServer, type RecallMcpContext } from "./recallTools.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

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
    recall: { createId: () => `id-${(sequence += 1)}`, db }
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

beforeEach(async () => {
  ctx = await buildCtx();
});

afterEach(async () => {
  await ctx.db.$client.close();
});

describe("callRecallTool", () => {
  it("round-trips save -> list_due -> record_review -> get/search through the real store", async () => {
    const saved = (await callRecallTool(ctx.context, "save_recall_item", {
      gloss: "to reveal a secret",
      kind: "idiom",
      text: "spill the beans"
    })) as Awaited<ReturnType<typeof callRecallTool>>;
    const item = dataOf(saved) as { id: string; review: { dueAt: string } };
    expect(item.id).toBe("id-1");
    expect(item.review.dueAt).toBe(t0.toISOString());

    const due = dataOf(await callRecallTool(ctx.context, "list_due_items", {})) as {
      items: ReadonlyArray<{ id: string }>;
    };
    expect(due.items.map((i) => i.id)).toEqual(["id-1"]);

    const reviewed = dataOf(
      await callRecallTool(ctx.context, "record_review", { grade: 4, itemId: "id-1" })
    ) as { review: { dueAt: string; intervalDays: number; repetitions: number } };
    expect(reviewed.review).toMatchObject({ intervalDays: 1, repetitions: 1 });
    expect(reviewed.review.dueAt).toBe(new Date(t0.getTime() + day).toISOString());

    // Reviewing pushed the due date into the future, so it drops out of the due list.
    const dueAfter = dataOf(await callRecallTool(ctx.context, "list_due_items", {})) as {
      items: ReadonlyArray<unknown>;
    };
    expect(dueAfter.items).toEqual([]);

    const fetched = dataOf(
      await callRecallTool(ctx.context, "get_recall_item", { id: "id-1" })
    ) as {
      text: string;
    };
    expect(fetched.text).toBe("spill the beans");

    const found = dataOf(
      await callRecallTool(ctx.context, "search_recall_items", { query: "beans" })
    ) as {
      items: ReadonlyArray<{ id: string }>;
    };
    expect(found.items.map((i) => i.id)).toEqual(["id-1"]);
  });

  it("honors an explicit list_due_items limit", async () => {
    await callRecallTool(ctx.context, "save_recall_item", { kind: "word", text: "one" });
    await callRecallTool(ctx.context, "save_recall_item", { kind: "word", text: "two" });

    const due = dataOf(await callRecallTool(ctx.context, "list_due_items", { limit: 1 })) as {
      items: ReadonlyArray<unknown>;
    };
    expect(due.items).toHaveLength(1);
  });

  it("returns a clean error for invalid input, not a crash", async () => {
    const result = await callRecallTool(ctx.context, "save_recall_item", { kind: "word" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });

  it("returns a clean error for an unknown tool", async () => {
    const result = await callRecallTool(ctx.context, "no_such_tool", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tool");
  });

  it("labels a root-level validation error when the arguments are not an object", async () => {
    const result = await callRecallTool(ctx.context, "save_recall_item", "not-an-object");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("(root)");
  });

  it("returns a clean error when reviewing a missing item", async () => {
    const result = await callRecallTool(ctx.context, "record_review", { grade: 4, itemId: "nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No recall item with id nope");
  });

  it("returns a clean error when fetching a missing item", async () => {
    const result = await callRecallTool(ctx.context, "get_recall_item", { id: "nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No recall item with id nope");
  });
});

describe("createRecallMcpServer", () => {
  it("advertises the five recall tools and serves a call end-to-end over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createRecallMcpServer(ctx.context);
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_recall_item",
        "list_due_items",
        "record_review",
        "save_recall_item",
        "search_recall_items"
      ]);

      const saved = await client.callTool({
        arguments: { kind: "phrase", text: "by and large" },
        name: "save_recall_item"
      });
      const item = JSON.parse((saved.content as Array<{ text: string }>)[0].text) as { id: string };
      expect(item.id).toBe("id-1");

      const invalid = await client.callTool({ arguments: {}, name: "get_recall_item" });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
