import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  entries,
  entryLinks,
  memoryNotes,
  memoryPromptReviews,
  memoryPrompts,
  personalEntries
} from "../../db/schema.js";
import {
  addPromptToNote,
  deleteMemoryNote,
  depositMemory,
  editMemoryNote,
  editMemoryPrompt,
  recordPromptReview,
  type MemoryDependencies
} from "./memoryCommands.js";
import { getMemoryNoteDetail, listMemoryNotes, searchMemoryNotes } from "./memoryQueries.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{ db: DbClient; deps: MemoryDependencies }>;
let context: TestContext;

function buildDeps(
  db: DbClient,
  resolveOfflineGloss?: (text: string) => Promise<string | null>
): MemoryDependencies {
  let sequence = 0;
  return {
    createId: () => `id-${(sequence += 1)}`,
    db,
    ...(resolveOfflineGloss === undefined ? {} : { resolveOfflineGloss })
  };
}

async function buildContext(
  resolveOfflineGloss?: (text: string) => Promise<string | null>
): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return { db, deps: buildDeps(db, resolveOfflineGloss) };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("listMemoryNotes", () => {
  it("summarizes each owned note's prompts (counts + due state), newest first, scoped to the owner", async () => {
    // Older note: one scheduled + one draft prompt.
    const older = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "遠慮 — to hold back out of consideration",
        prompts: [
          { cueText: "when holding back out of consideration", answerText: "遠慮" },
          { cueText: "no answer yet" }
        ]
      },
      userA,
      at(1)
    );
    // Newer note: draft-only.
    const newer = await depositMemory(
      context.deps,
      { captureSource: "reader", noteText: "unknown term", prompts: [{ cueText: "unknown term" }] },
      userA,
      at(2)
    );
    // Another user's note must never appear.
    await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "not yours",
        prompts: [{ cueText: "x", answerText: "y" }]
      },
      userB,
      at(2)
    );

    const items = await listMemoryNotes(context.db, userA, at(5));
    expect(items.map((item) => item.noteId)).toEqual([newer.note.noteId, older.note.noteId]);

    const olderSummary = items.find((item) => item.noteId === older.note.noteId);
    expect(olderSummary).toMatchObject({
      captureSource: "manual",
      bodyText: "遠慮 — to hold back out of consideration",
      promptCount: 2,
      draftCount: 1,
      scheduledCount: 1,
      dueCount: 1
    });
    expect(olderSummary?.nextDueAt).toBe(at(1).toISOString());

    const newerSummary = items.find((item) => item.noteId === newer.note.noteId);
    expect(newerSummary).toMatchObject({
      promptCount: 1,
      draftCount: 1,
      scheduledCount: 0,
      dueCount: 0,
      nextDueAt: null
    });
  });

  it("does not count a scheduled prompt as due before its due date", async () => {
    const note = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "body",
        prompts: [{ cueText: "cue", answerText: "ans" }]
      },
      userA,
      at(10)
    );
    // Query BEFORE the seeded due date (the seeded card is due at at(10)).
    const items = await listMemoryNotes(context.db, userA, at(5));
    const summary = items.find((item) => item.noteId === note.note.noteId);
    expect(summary?.scheduledCount).toBe(1);
    expect(summary?.dueCount).toBe(0);
    expect(summary?.nextDueAt).toBe(at(10).toISOString());
  });

  it("returns an empty list when the user owns no notes", async () => {
    expect(await listMemoryNotes(context.db, userA, at(5))).toEqual([]);
  });

  it("summarizes a note that has no prompts with zero counts", async () => {
    // A promptless note (every direction pruned) still lists, exercising the empty-bucket fallback.
    await context.db.insert(entries).values({ id: "bare-list", type: "note" });
    await context.db.insert(personalEntries).values({
      createdAt: at(1),
      entryId: "bare-list",
      occurredAt: at(1),
      updatedAt: at(1),
      userId: userA
    });
    await context.db.insert(memoryNotes).values({
      bodyDoc: { type: "doc", content: [] },
      bodyText: "lonely fragment",
      captureSource: "manual",
      entryId: "bare-list"
    });

    const items = await listMemoryNotes(context.db, userA, at(5));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      noteId: "bare-list",
      bodyText: "lonely fragment",
      promptCount: 0,
      draftCount: 0,
      scheduledCount: 0,
      dueCount: 0,
      nextDueAt: null
    });
  });
});

describe("searchMemoryNotes", () => {
  it("matches on the note body OR a prompt's cue/answer, surfacing each note once, scoped to the owner", async () => {
    const byBody = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "photosynthesis converts light to energy",
        prompts: [{ cueText: "a plant process" }]
      },
      userA,
      at(1)
    );
    const byPrompt = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "a botany fact",
        prompts: [
          { cueText: "photosynthesis in one word", answerText: "growth" },
          { cueText: "another photosynthesis cue", answerText: "light" }
        ]
      },
      userA,
      at(2)
    );
    await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "photosynthesis (other user)",
        prompts: [{ cueText: "x", answerText: "y" }]
      },
      userB,
      at(2)
    );

    const results = await searchMemoryNotes(context.db, userA, "photosynthesis", at(5));
    const ids = results.map((item) => item.noteId).sort();
    expect(ids).toEqual([byBody.note.noteId, byPrompt.note.noteId].sort());
    // Two matching prompts under one note still surface that note exactly once.
    expect(results.filter((item) => item.noteId === byPrompt.note.noteId)).toHaveLength(1);
  });

  it("returns nothing when nothing matches", async () => {
    await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "apples",
        prompts: [{ cueText: "fruit", answerText: "apple" }]
      },
      userA,
      at(1)
    );
    expect(await searchMemoryNotes(context.db, userA, "zzzznomatch", at(5))).toEqual([]);
  });
});

describe("getMemoryNoteDetail", () => {
  it("returns the note with provenance and every prompt (draft + scheduled), oldest first", async () => {
    await context.db.insert(entries).values({ id: "source-1", type: "note" });
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "reader",
        noteText: "idiom note",
        derivedFromEntryId: "source-1",
        prompts: [{ cueText: "scheduled cue", answerText: "answer" }, { cueText: "draft cue" }]
      },
      userA,
      at(1)
    );

    const detail = await getMemoryNoteDetail(context.db, userA, deposit.note.noteId);
    expect(detail?.note.derivedFromEntryId).toBe("source-1");
    expect(detail?.prompts).toHaveLength(2);
    expect(detail?.prompts[0]?.lifecycle).toBe("scheduled");
    expect(detail?.prompts[1]?.lifecycle).toBe("draft");
  });

  it("is undefined for another user's note or a missing note", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "mine", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );
    expect(await getMemoryNoteDetail(context.db, userB, deposit.note.noteId)).toBeUndefined();
    expect(await getMemoryNoteDetail(context.db, userA, "no-such-note")).toBeUndefined();
  });
});

describe("editMemoryNote", () => {
  it("rewrites the body and bumps updatedAt without touching prompts", async () => {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "old body",
        prompts: [{ cueText: "c", answerText: "a" }]
      },
      userA,
      at(1)
    );

    const result = await editMemoryNote(
      context.deps,
      deposit.note.noteId,
      userA,
      "new body",
      at(3)
    );
    expect(result.status).toBe("updated");
    if (result.status !== "updated") {
      return;
    }
    expect(result.detail.note.bodyText).toBe("new body");
    expect(result.detail.prompts).toHaveLength(1);

    const facet = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, deposit.note.noteId));
    expect(facet[0]?.updatedAt).toEqual(at(3));
    // The capture source (structured provenance) is never rewritten by a body edit.
    expect(result.detail.note.captureSource).toBe("manual");
  });

  it("is not_found for another user's note", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "mine", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );
    const result = await editMemoryNote(context.deps, deposit.note.noteId, userB, "hax", at(2));
    expect(result.status).toBe("not_found");
  });
});

describe("editMemoryPrompt", () => {
  it("keeps the existing card and review history when a scheduled prompt stays scheduled", async () => {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "body",
        prompts: [{ cueText: "cue", answerText: "answer" }]
      },
      userA,
      at(1)
    );
    const promptId = deposit.prompts[0]?.promptId as string;
    // Record a real review so there is history and an advanced card.
    await recordPromptReview(context.deps, promptId, "good", userA, at(2));
    const before = (
      await context.db.select().from(memoryPrompts).where(eq(memoryPrompts.entryId, promptId))
    )[0];

    const result = await editMemoryPrompt(
      context.deps,
      promptId,
      userA,
      { cueText: "reworded cue", answerText: "reworded answer" },
      at(3)
    );
    expect(result.status).toBe("updated");

    const after = (
      await context.db.select().from(memoryPrompts).where(eq(memoryPrompts.entryId, promptId))
    )[0];
    expect(after?.lifecycle).toBe("scheduled");
    expect(after?.cueText).toBe("reworded cue");
    expect(after?.answerText).toBe("reworded answer");
    // The FSRS schedule is preserved (content edit never resets review history).
    expect(after?.dueAt).toEqual(before?.dueAt);
    expect(after?.reps).toBe(before?.reps);
    expect(after?.stability).toBe(before?.stability);
    // The append-only review log survives the edit.
    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(1);
  });

  it("seeds a fresh card when a draft becomes schedulable", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "body", prompts: [{ cueText: "draft cue" }] },
      userA,
      at(1)
    );
    const promptId = deposit.prompts[0]?.promptId as string;

    const result = await editMemoryPrompt(
      context.deps,
      promptId,
      userA,
      { cueText: "draft cue", answerText: "now answerable" },
      at(5)
    );
    expect(result.status).toBe("updated");
    if (result.status !== "updated") {
      return;
    }
    expect(result.prompt.lifecycle).toBe("scheduled");
    expect(result.prompt.review?.due).toBe(at(5).toISOString());
  });

  it("reverts to a draft and drops the card, keeping the review log, when the answer is removed", async () => {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "body",
        prompts: [{ cueText: "cue", answerText: "answer" }]
      },
      userA,
      at(1)
    );
    const promptId = deposit.prompts[0]?.promptId as string;
    await recordPromptReview(context.deps, promptId, "again", userA, at(2));

    const result = await editMemoryPrompt(
      context.deps,
      promptId,
      userA,
      { cueText: "cue", answerText: null },
      at(3)
    );
    expect(result.status).toBe("updated");

    const after = (
      await context.db.select().from(memoryPrompts).where(eq(memoryPrompts.entryId, promptId))
    )[0];
    expect(after?.lifecycle).toBe("draft");
    expect(after?.answerText).toBeNull();
    expect(after?.answerDoc).toBeNull();
    expect(after?.dueAt).toBeNull();
    expect(after?.stability).toBeNull();
    // The history is never deleted, even when the card is dropped.
    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(1);
  });

  it("is not_found for another user's prompt", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "body", prompts: [{ cueText: "cue", answerText: "a" }] },
      userA,
      at(1)
    );
    const result = await editMemoryPrompt(
      context.deps,
      deposit.prompts[0]?.promptId as string,
      userB,
      { cueText: "hax", answerText: "hax" },
      at(2)
    );
    expect(result.status).toBe("not_found");
  });
});

describe("addPromptToNote", () => {
  it("adds a scheduled direction under an owned note and links it", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "body", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );

    const result = await addPromptToNote(
      context.deps,
      deposit.note.noteId,
      userA,
      { cueText: "second direction", answerText: "second answer" },
      at(2)
    );
    expect(result.status).toBe("added");
    if (result.status !== "added") {
      return;
    }
    expect(result.detail.prompts).toHaveLength(2);
    const added = result.detail.prompts.find((prompt) => prompt.cueText === "second direction");
    expect(added?.lifecycle).toBe("scheduled");

    const links = await context.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.fromEntryId, deposit.note.noteId));
    // One `contains` link per prompt (2), no extra provenance link on a manual note.
    expect(links.filter((link) => link.type === "contains")).toHaveLength(2);
  });

  it("saves an answerless direction as a draft", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "body", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );
    const result = await addPromptToNote(
      context.deps,
      deposit.note.noteId,
      userA,
      { cueText: "answerless" },
      at(2)
    );
    expect(result.status).toBe("added");
    if (result.status !== "added") {
      return;
    }
    const added = result.detail.prompts.find((prompt) => prompt.cueText === "answerless");
    expect(added?.lifecycle).toBe("draft");
    expect(added?.answerText).toBeNull();
  });

  it("resolves a bare term's answer from the offline dictionary, scheduling it", async () => {
    const context2 = await buildContext(async (term) =>
      term === "遠慮" ? "to hold back out of consideration" : null
    );
    try {
      const deposit = await depositMemory(
        context2.deps,
        { captureSource: "manual", noteText: "body", prompts: [{ cueText: "c", answerText: "a" }] },
        userA,
        at(1)
      );
      const result = await addPromptToNote(
        context2.deps,
        deposit.note.noteId,
        userA,
        { cueText: "遠慮", glossTerm: "遠慮" },
        at(2)
      );
      expect(result.status).toBe("added");
      if (result.status !== "added") {
        return;
      }
      const added = result.detail.prompts.find((prompt) => prompt.cueText === "遠慮");
      expect(added?.lifecycle).toBe("scheduled");
      expect(added?.answerText).toBe("to hold back out of consideration");
    } finally {
      await context2.db.$client.close();
    }
  });

  it("is not_found for another user's note", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "body", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );
    const result = await addPromptToNote(
      context.deps,
      deposit.note.noteId,
      userB,
      { cueText: "hax", answerText: "hax" },
      at(2)
    );
    expect(result.status).toBe("not_found");
  });
});

describe("deleteMemoryNote", () => {
  it("atomically removes the note, its prompts, reviews, links, and Entries; leaves other notes intact", async () => {
    await context.db.insert(entries).values({ id: "source-1", type: "note" });
    const target = await depositMemory(
      context.deps,
      {
        captureSource: "reader",
        noteText: "delete me",
        derivedFromEntryId: "source-1",
        prompts: [{ cueText: "scheduled", answerText: "answer" }, { cueText: "draft" }]
      },
      userA,
      at(1)
    );
    const keep = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "keep me",
        prompts: [{ cueText: "c", answerText: "a" }]
      },
      userA,
      at(2)
    );
    const scheduledPromptId = target.prompts[0]?.promptId as string;
    await recordPromptReview(context.deps, scheduledPromptId, "good", userA, at(2));

    const result = await deleteMemoryNote(context.deps, target.note.noteId, userA);
    expect(result.status).toBe("deleted");

    // Everything under the target note is gone.
    expect(
      await context.db.select().from(memoryNotes).where(eq(memoryNotes.entryId, target.note.noteId))
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(memoryPrompts)
        .where(eq(memoryPrompts.noteEntryId, target.note.noteId))
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(memoryPromptReviews)
        .where(eq(memoryPromptReviews.promptEntryId, scheduledPromptId))
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(personalEntries)
        .where(eq(personalEntries.entryId, target.note.noteId))
    ).toHaveLength(0);
    expect(
      await context.db.select().from(entries).where(eq(entries.id, scheduledPromptId))
    ).toHaveLength(0);
    // The other note is untouched.
    expect(await getMemoryNoteDetail(context.db, userA, keep.note.noteId)).toBeDefined();
  });

  it("is not_found for another user's note and deletes nothing", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "mine", prompts: [{ cueText: "c", answerText: "a" }] },
      userA,
      at(1)
    );
    const result = await deleteMemoryNote(context.deps, deposit.note.noteId, userB);
    expect(result.status).toBe("not_found");
    expect(await getMemoryNoteDetail(context.db, userA, deposit.note.noteId)).toBeDefined();
  });

  it("removes a note that has no prompts", async () => {
    // A note with zero prompts (e.g. after every direction was pruned) still deletes cleanly: the
    // prompt/review branches are skipped and only the note's own facets are removed.
    await context.db.insert(entries).values({ id: "bare-note", type: "note" });
    await context.db.insert(personalEntries).values({
      createdAt: at(1),
      entryId: "bare-note",
      occurredAt: at(1),
      updatedAt: at(1),
      userId: userA
    });
    await context.db.insert(memoryNotes).values({
      bodyDoc: { type: "doc", content: [] },
      bodyText: "no prompts",
      captureSource: "manual",
      entryId: "bare-note"
    });

    const result = await deleteMemoryNote(context.deps, "bare-note", userA);
    expect(result.status).toBe("deleted");
    expect(
      await context.db.select().from(memoryNotes).where(eq(memoryNotes.entryId, "bare-note"))
    ).toHaveLength(0);
    expect(await context.db.select().from(entries).where(eq(entries.id, "bare-note"))).toHaveLength(
      0
    );
  });
});
