import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newReviewState } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { cases, chunks, domains, entries } from "../../db/schema.js";
import { depositMemory, type MemoryDependencies } from "./memoryCommands.js";
import {
  allChunkReviewStates,
  getMemoryPromptForUser,
  getPromptByCueTextForUser,
  getScheduledPromptByChunkForUser,
  listDuePromptCards,
  noteProvenanceEntryId,
  reviewStatesByChunkIds,
  searchMemoryPrompts
} from "./memoryQueries.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{ db: DbClient; deps: MemoryDependencies }>;
let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  let sequence = 0;
  return { db, deps: { createId: () => `id-${(sequence += 1)}`, db } };
}

// A memory prompt's chunk FK requires a real chunk (and its case/domain chain); seed a minimal one.
async function seedChunk(id: string): Promise<void> {
  await context.db
    .insert(domains)
    .values({ id: "dom", name: "Dom", weight: 0.5, orderIndex: 0 })
    .onConflictDoNothing();
  await context.db
    .insert(cases)
    .values({
      id: "case",
      domainId: "dom",
      communicativeFunction: "f",
      situation: "s",
      orderIndex: 0
    })
    .onConflictDoNothing();
  await context.db
    .insert(chunks)
    .values({ id, caseId: "case", orderIndex: 0, text: id })
    .onConflictDoNothing();
}

// Seed one prompt under a fresh note. A supplied answer schedules the prompt; omit it for a draft.
async function seedPrompt(
  params: Readonly<{
    userId: string;
    cueText: string;
    answerText?: string;
    chunkId?: string;
    derivedFromEntryId?: string;
    now: Date;
  }>
): Promise<Readonly<{ promptId: string; noteId: string }>> {
  if (params.chunkId !== undefined) {
    await seedChunk(params.chunkId);
  }
  const deposit = await depositMemory(
    context.deps,
    {
      captureSource: "practice",
      noteText: params.cueText,
      ...(params.derivedFromEntryId === undefined
        ? {}
        : { derivedFromEntryId: params.derivedFromEntryId }),
      prompts: [
        {
          cueText: params.cueText,
          ...(params.answerText === undefined ? {} : { answerText: params.answerText }),
          ...(params.chunkId === undefined ? {} : { chunkId: params.chunkId })
        }
      ]
    },
    params.userId,
    params.now
  );
  return { promptId: deposit.prompts[0]!.promptId, noteId: deposit.note.noteId };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("getMemoryPromptForUser", () => {
  it("returns the owner's prompt as a DTO and nothing for a miss or another user", async () => {
    const { promptId } = await seedPrompt({
      userId: userA,
      cueText: "cue",
      answerText: "answer",
      now: t0
    });

    const dto = await getMemoryPromptForUser(context.db, promptId, userA);
    expect(dto?.promptId).toBe(promptId);
    expect(dto?.answerText).toBe("answer");

    expect(await getMemoryPromptForUser(context.db, promptId, userB)).toBeUndefined();
    expect(await getMemoryPromptForUser(context.db, "missing", userA)).toBeUndefined();
  });
});

describe("getScheduledPromptByChunkForUser", () => {
  it("returns the newest scheduled prompt for the chunk, excluding drafts and other users", async () => {
    await seedPrompt({
      userId: userA,
      cueText: "older",
      answerText: "a",
      chunkId: "chunk-1",
      now: t0
    });
    const newer = await seedPrompt({
      userId: userA,
      cueText: "newer",
      answerText: "a",
      chunkId: "chunk-1",
      now: at(1)
    });

    const row = await getScheduledPromptByChunkForUser(context.db, userA, "chunk-1");
    expect(row?.entryId).toBe(newer.promptId);

    // A draft linked to a chunk is not a schedulable match.
    await seedPrompt({ userId: userA, cueText: "draft", chunkId: "chunk-2", now: t0 });
    expect(await getScheduledPromptByChunkForUser(context.db, userA, "chunk-2")).toBeUndefined();

    expect(await getScheduledPromptByChunkForUser(context.db, userB, "chunk-1")).toBeUndefined();
  });
});

describe("getPromptByCueTextForUser", () => {
  it("returns the newest prompt with the exact cue, or nothing", async () => {
    await seedPrompt({ userId: userA, cueText: "same cue", answerText: "a", now: t0 });
    const newer = await seedPrompt({
      userId: userA,
      cueText: "same cue",
      answerText: "b",
      now: at(1)
    });

    const row = await getPromptByCueTextForUser(context.db, userA, "same cue");
    expect(row?.entryId).toBe(newer.promptId);

    expect(await getPromptByCueTextForUser(context.db, userA, "no such cue")).toBeUndefined();
  });
});

describe("listDuePromptCards", () => {
  it("returns the user's due scheduled cards soonest-first, capped, excluding drafts", async () => {
    const early = await seedPrompt({
      userId: userA,
      cueText: "early",
      answerText: "a",
      now: at(-2)
    });
    const mid = await seedPrompt({ userId: userA, cueText: "mid", answerText: "a", now: at(-1) });
    const late = await seedPrompt({ userId: userA, cueText: "late", answerText: "a", now: at(0) });
    await seedPrompt({ userId: userA, cueText: "draft", now: at(-2) });
    await seedPrompt({ userId: userB, cueText: "other", answerText: "a", now: at(-2) });

    const due = await listDuePromptCards(context.db, userA, at(0), 10);
    expect(due.map((card) => card.promptId)).toEqual([early.promptId, mid.promptId, late.promptId]);
    // The card face carries the revealable answer and the FSRS state.
    expect(due[0]?.answerText).toBe("a");
    expect(due[0]?.review).toEqual(newReviewState(at(-2)));

    expect(await listDuePromptCards(context.db, userA, at(0), 1)).toHaveLength(1);
  });
});

describe("searchMemoryPrompts", () => {
  beforeEach(async () => {
    await seedPrompt({
      userId: userA,
      cueText: "reveal a secret",
      answerText: "spill the beans",
      now: t0
    });
    await seedPrompt({ userId: userA, cueText: "100% sure", answerText: "certain", now: t0 });
    await seedPrompt({ userId: userA, cueText: "a_b pattern", answerText: "x", now: t0 });
    await seedPrompt({
      userId: userB,
      cueText: "reveal a secret",
      answerText: "spill the beans",
      now: t0
    });
  });

  it("matches the cue case-insensitively", async () => {
    const results = await searchMemoryPrompts(context.db, userA, "REVEAL");
    expect(results.map((r) => r.cueText)).toEqual(["reveal a secret"]);
  });

  it("matches the answer", async () => {
    const results = await searchMemoryPrompts(context.db, userA, "beans");
    expect(results.map((r) => r.cueText)).toEqual(["reveal a secret"]);
  });

  it("treats LIKE metacharacters literally", async () => {
    expect((await searchMemoryPrompts(context.db, userA, "100%")).map((r) => r.cueText)).toEqual([
      "100% sure"
    ]);
    expect((await searchMemoryPrompts(context.db, userA, "a_b")).map((r) => r.cueText)).toEqual([
      "a_b pattern"
    ]);
  });

  it("is scoped to the user and empty on a non-match", async () => {
    expect(await searchMemoryPrompts(context.db, userA, "zzz")).toEqual([]);
  });
});

describe("chunk review-state grouping", () => {
  it("groups the user's scheduled prompt states by chunk, excluding drafts, null chunks, and other users", async () => {
    await seedPrompt({
      userId: userA,
      cueText: "c1-a",
      answerText: "a",
      chunkId: "chunk-1",
      now: t0
    });
    await seedPrompt({
      userId: userA,
      cueText: "c1-b",
      answerText: "a",
      chunkId: "chunk-1",
      now: at(1)
    });
    await seedPrompt({
      userId: userA,
      cueText: "c2",
      answerText: "a",
      chunkId: "chunk-2",
      now: t0
    });
    await seedPrompt({ userId: userA, cueText: "draft", chunkId: "chunk-3", now: t0 });
    await seedPrompt({ userId: userA, cueText: "no-chunk", answerText: "a", now: t0 });
    await seedPrompt({
      userId: userB,
      cueText: "other",
      answerText: "a",
      chunkId: "chunk-1",
      now: t0
    });

    const all = await allChunkReviewStates(context.db, userA);
    expect([...all.keys()].sort()).toEqual(["chunk-1", "chunk-2"]);
    expect(all.get("chunk-1")).toHaveLength(2);
    expect(all.get("chunk-2")).toHaveLength(1);

    const subset = await reviewStatesByChunkIds(context.db, userA, ["chunk-2"]);
    expect([...subset.keys()]).toEqual(["chunk-2"]);

    // An empty id set short-circuits to an empty map without a query.
    const empty = await reviewStatesByChunkIds(context.db, userA, []);
    expect(empty.size).toBe(0);
  });
});

describe("noteProvenanceEntryId", () => {
  it("returns the derived_from target, or null when a note has no provenance", async () => {
    await context.db.insert(entries).values({ id: "source-1", type: "note" });
    const derived = await seedPrompt({
      userId: userA,
      cueText: "cue",
      answerText: "a",
      derivedFromEntryId: "source-1",
      now: t0
    });
    expect(await noteProvenanceEntryId(context.db, derived.noteId)).toBe("source-1");

    const standalone = await seedPrompt({
      userId: userA,
      cueText: "cue2",
      answerText: "a",
      now: t0
    });
    expect(await noteProvenanceEntryId(context.db, standalone.noteId)).toBeNull();
  });
});
