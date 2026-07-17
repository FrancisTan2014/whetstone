import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, memoryPrompts, notes, personalEntries, reviewCards } from "../../db/schema.js";
import { reviewStateColumns } from "../review/reviewCardQueries.js";
import { getPromptRowForUser, loadNoteReviewRoutineSummary } from "./notePromptQueries.js";

const userA = "user-a";
const userB = "user-b";

let context: Readonly<{ db: DbClient }>;
let sequence = 0;

async function buildContext(): Promise<Readonly<{ db: DbClient }>> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return { db: createDbClient(pglite) };
}

// Seed a Notes-owned ready prompt (a saved note + its current-note prompt) directly. When `dueAt` is given
// an active shared review card is scheduled at that instant; omit it for a draft (a prompt with no card).
async function seedPrompt(
  params: Readonly<{ userId: string; cueText: string; dueAt?: Date }>
): Promise<Readonly<{ promptId: string; noteId: string }>> {
  const noteId = `note-${(sequence += 1)}`;
  const promptId = `prompt-${(sequence += 1)}`;
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  await context.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: noteId, type: "note" });
    await tx.insert(personalEntries).values({
      createdAt,
      entryId: noteId,
      occurredAt: createdAt,
      updatedAt: createdAt,
      userId: params.userId
    });
    await tx.insert(notes).values({
      bodyDoc: createTextDocument(params.cueText),
      bodyText: params.cueText,
      captureSource: "manual",
      entryId: noteId,
      kind: "note"
    });
    await tx.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await tx.insert(memoryPrompts).values({
      answerDoc: null,
      answerText: null,
      chunkId: null,
      createdAt,
      cueDoc: createTextDocument(params.cueText),
      cueText: params.cueText,
      entryId: promptId,
      lifecycle: "ready",
      noteEntryId: noteId,
      revealKind: "current_note"
    });
    if (params.dueAt !== undefined) {
      await tx.insert(reviewCards).values({
        ...reviewStateColumns(newReviewState(createdAt)),
        dueAt: params.dueAt,
        requestedRetention: RECALL_REQUEST_RETENTION,
        status: "active",
        targetEntryId: promptId,
        userId: params.userId
      });
    }
  });
  return { noteId, promptId };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("getPromptRowForUser", () => {
  it("returns the owner's prompt row and nothing for a miss or another user", async () => {
    const { promptId } = await seedPrompt({ cueText: "cue", userId: userA });

    const row = await getPromptRowForUser(context.db, promptId, userA);
    expect(row?.entryId).toBe(promptId);
    expect(row?.revealKind).toBe("current_note");

    expect(await getPromptRowForUser(context.db, promptId, userB)).toBeUndefined();
    expect(await getPromptRowForUser(context.db, "missing", userA)).toBeUndefined();
  });
});

describe("loadNoteReviewRoutineSummary", () => {
  const zone = "UTC";

  it("counts due and overdue enrolled cards and reports the earliest due instant", async () => {
    await seedPrompt({
      cueText: "overdue",
      dueAt: new Date("2026-01-01T00:00:00.000Z"),
      userId: userA
    });
    await seedPrompt({
      cueText: "dueToday",
      dueAt: new Date("2026-01-02T06:00:00.000Z"),
      userId: userA
    });
    await seedPrompt({
      cueText: "future",
      dueAt: new Date("2026-01-03T00:00:00.000Z"),
      userId: userA
    });
    await seedPrompt({ cueText: "draft", userId: userA });
    await seedPrompt({
      cueText: "other",
      dueAt: new Date("2026-01-01T00:00:00.000Z"),
      userId: userB
    });

    const summary = await loadNoteReviewRoutineSummary(
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
    await seedPrompt({
      cueText: "later",
      dueAt: new Date("2026-01-05T00:00:00.000Z"),
      userId: userA
    });

    const summary = await loadNoteReviewRoutineSummary(
      context.db,
      userA,
      new Date("2026-01-02T12:00:00.000Z"),
      zone
    );

    expect(summary).toEqual({ dueCount: 0, nextDueAt: null, overdueCount: 0 });
  });
});
