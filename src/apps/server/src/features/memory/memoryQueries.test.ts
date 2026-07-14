import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newReviewState } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, reviewCards } from "../../db/schema.js";
import { depositMemory, type MemoryDependencies } from "./memoryCommands.js";
import {
  getMemoryPromptForUser,
  listDuePromptCards,
  loadMemoryRoutineSummary,
  noteProvenanceEntryId,
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

// Seed one prompt under a fresh note. A supplied answer schedules the prompt; omit it for a draft.
async function seedPrompt(
  params: Readonly<{
    userId: string;
    cueText: string;
    answerText?: string;
    derivedFromEntryId?: string;
    now: Date;
  }>
): Promise<Readonly<{ promptId: string; noteId: string }>> {
  const deposit = await depositMemory(
    context.deps,
    {
      captureSource: "diary",
      noteText: params.cueText,
      ...(params.derivedFromEntryId === undefined
        ? {}
        : { derivedFromEntryId: params.derivedFromEntryId }),
      prompts: [
        {
          cueText: params.cueText,
          ...(params.answerText === undefined ? {} : { answerText: params.answerText })
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

describe("loadMemoryRoutineSummary", () => {
  const zone = "UTC";
  const setDueAt = async (promptId: string, iso: string): Promise<void> => {
    await context.db
      .update(reviewCards)
      .set({ dueAt: new Date(iso) })
      .where(eq(reviewCards.targetEntryId, promptId));
  };

  it("counts due and overdue enrolled cards and reports the earliest due instant", async () => {
    const overdue = await seedPrompt({ userId: userA, cueText: "a", answerText: "x", now: t0 });
    const dueToday = await seedPrompt({ userId: userA, cueText: "b", answerText: "x", now: t0 });
    const future = await seedPrompt({ userId: userA, cueText: "c", answerText: "x", now: t0 });
    await seedPrompt({ userId: userA, cueText: "draft", now: t0 });
    const otherUser = await seedPrompt({ userId: userB, cueText: "d", answerText: "x", now: t0 });

    await setDueAt(overdue.promptId, "2026-01-01T00:00:00.000Z");
    await setDueAt(dueToday.promptId, "2026-01-02T06:00:00.000Z");
    await setDueAt(future.promptId, "2026-01-03T00:00:00.000Z");
    await setDueAt(otherUser.promptId, "2026-01-01T00:00:00.000Z");

    const summary = await loadMemoryRoutineSummary(
      context.db,
      userA,
      new Date("2026-01-02T12:00:00.000Z"),
      zone
    );

    expect(summary).toEqual({
      dueCount: 2,
      nextDueAt: "2026-01-01T00:00:00.000Z",
      overdueCount: 1
    });
  });

  it("reports nothing due when every card is in the future", async () => {
    const later = await seedPrompt({ userId: userA, cueText: "a", answerText: "x", now: t0 });
    await setDueAt(later.promptId, "2026-01-05T00:00:00.000Z");

    const summary = await loadMemoryRoutineSummary(
      context.db,
      userA,
      new Date("2026-01-02T12:00:00.000Z"),
      zone
    );

    expect(summary).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });
});
