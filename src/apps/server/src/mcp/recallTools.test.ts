import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { entries } from "../db/schema.js";
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

  it("auto-fills a bare word's gloss via the offline glosser wired into the recall deps (#526)", async () => {
    const context: RecallMcpContext = {
      ...ctx.context,
      recall: { ...ctx.context.recall, resolveOfflineGloss: async (text) => `back for ${text}` }
    };

    const saved = (await callRecallTool(context, "save_recall_item", {
      kind: "word",
      text: "mitigation"
    })) as Awaited<ReturnType<typeof callRecallTool>>;
    const item = dataOf(saved) as { gloss: string | null };
    expect(item.gloss).toBe("back for mitigation");
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

describe("deposit_recall_item", () => {
  const validArgs = {
    kind: "phrase",
    target: "it depends on",
    cue: "expressing a dependency",
    useContext: "explaining what a result hinges on",
    category: "language",
    tags: ["grammar", "preposition"],
    gloss: "use 'on' after 'depends'"
  } as const;

  it("saves a production-style recall item with full metadata and SM-2 seeding, no proposal link", async () => {
    const saved = dataOf(await callRecallTool(ctx.context, "deposit_recall_item", validArgs)) as {
      id: string;
      text: string;
      kind: string;
      cue: string | null;
      useContext: string | null;
      category: string | null;
      tags: ReadonlyArray<string> | null;
      gloss: string | null;
      provenanceEntryId: string | null;
      sourceProposalCandidateId: string | null;
      chunkId: string | null;
      review: { dueAt: string; repetitions: number };
    };

    expect(saved).toMatchObject({
      id: "id-1",
      text: "it depends on",
      kind: "phrase",
      cue: "expressing a dependency",
      useContext: "explaining what a result hinges on",
      category: "language",
      tags: ["grammar", "preposition"],
      gloss: "use 'on' after 'depends'",
      // Deposits never forge an integrity-bearing link or a chunk association.
      provenanceEntryId: null,
      sourceProposalCandidateId: null,
      chunkId: null
    });
    // SM-2 seeded due immediately, so it is reviewable normally right away.
    expect(saved.review).toMatchObject({ dueAt: t0.toISOString(), repetitions: 0 });

    // The deposited item is listable and fetchable through the existing recall tools.
    const due = dataOf(await callRecallTool(ctx.context, "list_due_items", {})) as {
      items: ReadonlyArray<{ id: string }>;
    };
    expect(due.items.map((i) => i.id)).toEqual(["id-1"]);
    const fetched = dataOf(
      await callRecallTool(ctx.context, "get_recall_item", { id: "id-1" })
    ) as { text: string };
    expect(fetched.text).toBe("it depends on");
  });

  it("preserves the provenance link when a valid source entry is supplied", async () => {
    await ctx.db.insert(entries).values({ id: "prov-1", type: "timeline_entry" });

    const saved = dataOf(
      await callRecallTool(ctx.context, "deposit_recall_item", {
        kind: "phrase",
        target: "roll back the deploy",
        cue: "reverting a release",
        useContext: "incident updates",
        category: "work",
        provenanceEntryId: "prov-1"
      })
    ) as { provenanceEntryId: string | null };

    expect(saved.provenanceEntryId).toBe("prov-1");
  });

  it("saves without optional metadata (tags/gloss/provenance omitted)", async () => {
    const saved = dataOf(
      await callRecallTool(ctx.context, "deposit_recall_item", {
        kind: "word",
        target: "ubiquitous",
        cue: "everywhere at once",
        useContext: "describing something common",
        category: "language"
      })
    ) as {
      tags: ReadonlyArray<string> | null;
      gloss: string | null;
      provenanceEntryId: string | null;
    };

    expect(saved).toMatchObject({ tags: null, gloss: null, provenanceEntryId: null });
  });

  it.each([
    ["target", { ...validArgs, target: "   " }],
    ["cue", { ...validArgs, cue: "" }],
    ["useContext", { ...validArgs, useContext: "  " }]
  ])("rejects a blank %s with a clean validation error", async (_field, args) => {
    const result = await callRecallTool(ctx.context, "deposit_recall_item", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });

  it("rejects input missing a required field (category) without saving", async () => {
    const { category: _omitted, ...withoutCategory } = validArgs;
    const result = await callRecallTool(ctx.context, "deposit_recall_item", withoutCategory);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
    const due = dataOf(await callRecallTool(ctx.context, "list_due_items", {})) as {
      items: ReadonlyArray<unknown>;
    };
    expect(due.items).toEqual([]);
  });
});

describe("createRecallMcpServer", () => {
  it("advertises the recall tools and serves a call end-to-end over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createRecallMcpServer(ctx.context);
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "deposit_recall_item",
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
