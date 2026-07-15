import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  entries,
  entryLinks,
  memoryPrompts,
  personalEntries,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import {
  createStandaloneNote,
  insertNoteInTx,
  type NotesDependencies
} from "../notes/noteCommands.js";
import { depositMemory, importMemoryBatch, type MemoryDependencies } from "./memoryCommands.js";
import {
  enrollNote,
  enrollPrompt,
  getNoteReview,
  pausePrompt,
  restartPrompt,
  resumePrompt
} from "./memoryEnrollment.js";

const userA = "user-a";
const userB = "user-b";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{ db: DbClient; deps: MemoryDependencies; notes: NotesDependencies }>;
let context: TestContext;
let now = t0;

function buildDeps(db: DbClient): MemoryDependencies {
  let sequence = 0;
  return { createId: () => `id-${(sequence += 1)}`, db };
}

function buildNotesDeps(db: DbClient): NotesDependencies {
  let sequence = 0;
  return { createEntryId: () => `note-${(sequence += 1)}`, db, now: () => now };
}

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return { db, deps: buildDeps(db), notes: buildNotesDeps(db) };
}

// A deliberate, empty manual note (no prompts) — the note-first starting point the learner enrolls later.
async function seedStandaloneNote(userId: string, when: Date): Promise<string> {
  now = when;
  const note = await createStandaloneNote(
    context.notes,
    { bodyDoc: createTextDocument("spill the beans") },
    userId
  );
  return note.entryId;
}

// An anchored Reader note (a block Entry + an anchored note) — the enrollment target the Memory-management
// read deliberately excludes. Used to prove enrollment accepts anchored notes.
let blockSequence = 0;
async function seedAnchoredNote(userId: string, when: Date): Promise<string> {
  const blockId = `block-${(blockSequence += 1)}`;
  await context.db.insert(entries).values({ id: blockId, type: "block" });
  const noteId = `anchored-${blockSequence}`;
  await context.db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor: {
        blockEntryId: toEntryId(blockId),
        contextSnapshot: "spill the beans",
        endBlockEntryId: toEntryId(blockId),
        endOffset: 5,
        selectedTextSnapshot: "spill",
        startOffset: 0
      },
      bodyDoc: createTextDocument("anchored note"),
      bodyText: "anchored note",
      captureSource: "reader",
      kind: "note",
      noteEntryId: toEntryId(noteId),
      now: when,
      userId
    })
  );
  return noteId;
}

// A bodyless mark (never enrollable) — a `kind = 'mark'` note.
async function seedMark(userId: string, when: Date): Promise<string> {
  const blockId = `block-${(blockSequence += 1)}`;
  await context.db.insert(entries).values({ id: blockId, type: "block" });
  const markId = `mark-${blockSequence}`;
  await context.db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor: {
        blockEntryId: toEntryId(blockId),
        contextSnapshot: "spill the beans",
        endBlockEntryId: toEntryId(blockId),
        endOffset: 5,
        selectedTextSnapshot: "spill",
        startOffset: 0
      },
      bodyDoc: null,
      bodyText: null,
      captureSource: "reader",
      kind: "mark",
      noteEntryId: toEntryId(markId),
      now: when,
      userId
    })
  );
  return markId;
}

async function cardCount(): Promise<number> {
  return (await context.db.select().from(reviewCards)).length;
}

async function promptCount(): Promise<number> {
  return (await context.db.select().from(memoryPrompts)).length;
}

beforeEach(async () => {
  now = t0;
  blockSequence = 0;
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("enrollNote (#575)", () => {
  it("creates one ready prompt and one active 0.90 card, returns the review, and bumps updatedAt", async () => {
    const noteId = await seedStandaloneNote(userA, t0);

    const result = await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );

    expect(result.status).toBe("enrolled");
    if (result.status !== "enrolled") {
      return;
    }
    expect(result.review.noteId).toBe(noteId);
    expect(result.review.prompts).toHaveLength(1);
    const prompt = result.review.prompts[0]!;
    expect(prompt.lifecycle).toBe("ready");
    expect(prompt.cueText).toBe("spill the beans");
    expect(prompt.answerText).toBe("to reveal a secret");
    expect(prompt.cardStatus).toBe("active");
    expect(prompt.review).not.toBeNull();

    // Exactly one active card at the recall retention policy, targeting the created prompt.
    const cards = await context.db.select().from(reviewCards);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.requestedRetention).toBe(RECALL_REQUEST_RETENTION);
    expect(cards[0]?.status).toBe("active");
    expect(cards[0]?.targetEntryId).toBe(prompt.promptId);

    // The prompt is linked under the note via a `contains` link.
    const links = await context.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.toEntryId, prompt.promptId));
    expect(links).toEqual([{ fromEntryId: noteId, toEntryId: prompt.promptId, type: "contains" }]);

    // Enrolling bumps the note's chronology.
    const owner = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, noteId));
    expect(owner[0]?.updatedAt.getTime()).toBe(at(1).getTime());
  });

  it("is idempotent: a repeated identical cue/reveal never duplicates the prompt or card", async () => {
    const noteId = await seedStandaloneNote(userA, t0);
    const request = { cueText: "spill the beans", answerText: "to reveal a secret" };

    await enrollNote(context.deps, noteId, userA, request, at(1));
    const second = await enrollNote(context.deps, noteId, userA, request, at(2));

    expect(second.status).toBe("enrolled");
    if (second.status === "enrolled") {
      expect(second.review.prompts).toHaveLength(1);
    }
    expect(await promptCount()).toBe(1);
    expect(await cardCount()).toBe(1);
  });

  it("adds a second prompt for a genuinely different cue/reveal pair", async () => {
    const noteId = await seedStandaloneNote(userA, t0);

    await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );
    const second = await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "to reveal a secret", answerText: "spill the beans" },
      at(2)
    );

    expect(second.status).toBe("enrolled");
    if (second.status === "enrolled") {
      expect(second.review.prompts).toHaveLength(2);
    }
    expect(await promptCount()).toBe(2);
    expect(await cardCount()).toBe(2);
  });

  it("enrolls an anchored Reader note (enrollment is not limited to unanchored notes)", async () => {
    const noteId = await seedAnchoredNote(userA, t0);

    const result = await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill", answerText: "to reveal a secret" },
      at(1)
    );

    expect(result.status).toBe("enrolled");
    expect(await cardCount()).toBe(1);
  });

  it("enrolls a still-cardless matching import in place instead of duplicating it", async () => {
    const [deposit] = await importMemoryBatch(
      context.deps,
      [
        {
          captureSource: "import",
          noteText: "spill the beans",
          prompts: [{ cueText: "spill the beans", answerText: "to reveal a secret" }]
        }
      ],
      userA,
      t0
    );
    const noteId = deposit!.note.noteId;
    const importedPromptId = deposit!.prompts[0]!.promptId;
    expect(await cardCount()).toBe(0);

    const result = await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );

    expect(result.status).toBe("enrolled");
    // The identical import is enrolled in place: still one prompt, now with a card.
    expect(await promptCount()).toBe(1);
    const cards = await context.db.select().from(reviewCards);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.targetEntryId).toBe(importedPromptId);
  });

  it("is not_found for another user's note and writes nothing", async () => {
    const noteId = await seedStandaloneNote(userB, t0);

    const result = await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );

    expect(result.status).toBe("not_found");
    expect(await promptCount()).toBe(0);
    expect(await cardCount()).toBe(0);
  });

  it("is not_found for a missing note", async () => {
    const result = await enrollNote(
      context.deps,
      "does-not-exist",
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );

    expect(result.status).toBe("not_found");
  });
});

// Import one note whose single prompt is ready-but-cardless, returning the note and prompt ids.
async function seedCardlessImport(
  userId: string,
  prompt: Readonly<{ cueText: string; answerText?: string }>
): Promise<Readonly<{ noteId: string; promptId: string }>> {
  const [deposit] = await importMemoryBatch(
    context.deps,
    [
      {
        captureSource: "import",
        noteText: prompt.cueText,
        prompts: [prompt.answerText === undefined ? { cueText: prompt.cueText } : prompt]
      }
    ],
    userId,
    t0
  );
  return { noteId: deposit!.note.noteId, promptId: deposit!.prompts[0]!.promptId };
}

describe("enrollPrompt (#575)", () => {
  it("seeds an active card for a ready-but-cardless imported prompt", async () => {
    const { promptId } = await seedCardlessImport(userA, {
      cueText: "spill the beans",
      answerText: "to reveal a secret"
    });

    const result = await enrollPrompt(context.deps, promptId, userA, at(1));

    expect(result.status).toBe("enrolled");
    if (result.status === "enrolled") {
      expect(result.prompt.promptId).toBe(promptId);
      expect(result.prompt.cardStatus).toBe("active");
      expect(result.prompt.review).not.toBeNull();
    }
    const cards = await context.db.select().from(reviewCards);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.requestedRetention).toBe(RECALL_REQUEST_RETENTION);
  });

  it("is not_ready for a draft prompt (no revealable answer)", async () => {
    const { promptId } = await seedCardlessImport(userA, { cueText: "spill the beans" });

    const result = await enrollPrompt(context.deps, promptId, userA, at(1));

    expect(result.status).toBe("not_ready");
    expect(await cardCount()).toBe(0);
  });

  it("is already_enrolled for a prompt that already has a card", async () => {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "practice",
        noteText: "spill the beans",
        prompts: [{ cueText: "spill the beans", answerText: "to reveal a secret" }]
      },
      userA,
      t0
    );
    const promptId = deposit.prompts[0]!.promptId;

    const result = await enrollPrompt(context.deps, promptId, userA, at(1));

    expect(result.status).toBe("already_enrolled");
    expect(await cardCount()).toBe(1);
  });

  it("is not_found for another user's prompt", async () => {
    const { promptId } = await seedCardlessImport(userB, {
      cueText: "spill the beans",
      answerText: "to reveal a secret"
    });

    const result = await enrollPrompt(context.deps, promptId, userA, at(1));

    expect(result.status).toBe("not_found");
    expect(await cardCount()).toBe(0);
  });
});

// Deposit one carded (enrolled) prompt, returning its id.
async function seedEnrolledPrompt(userId: string): Promise<string> {
  const deposit = await depositMemory(
    context.deps,
    {
      captureSource: "practice",
      noteText: "spill the beans",
      prompts: [{ cueText: "spill the beans", answerText: "to reveal a secret" }]
    },
    userId,
    t0
  );
  return deposit.prompts[0]!.promptId;
}

describe("pausePrompt / resumePrompt / restartPrompt (#575)", () => {
  it("pause withholds the card (status paused) without moving its due date", async () => {
    const promptId = await seedEnrolledPrompt(userA);
    const before = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0]!;

    const result = await pausePrompt(context.deps, promptId, userA, at(1));

    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.prompt.cardStatus).toBe("paused");
    }
    const after = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0]!;
    expect(after.status).toBe("paused");
    expect(after.dueAt.getTime()).toBe(before.dueAt.getTime());
  });

  it("resume returns a paused card to active, preserving its due date", async () => {
    const promptId = await seedEnrolledPrompt(userA);
    const before = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0]!;
    await pausePrompt(context.deps, promptId, userA, at(1));

    const result = await resumePrompt(context.deps, promptId, userA, at(2));

    expect(result.status).toBe("updated");
    if (result.status === "updated") {
      expect(result.prompt.cardStatus).toBe("active");
    }
    const after = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0]!;
    expect(after.status).toBe("active");
    expect(after.dueAt.getTime()).toBe(before.dueAt.getTime());
  });

  it("restart resets the schedule to a fresh card due now and records a reset event", async () => {
    const promptId = await seedEnrolledPrompt(userA);

    const result = await restartPrompt(context.deps, promptId, userA, at(3));

    expect(result.status).toBe("updated");
    const after = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0]!;
    expect(after.dueAt.getTime()).toBe(at(3).getTime());
    const events = await context.db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.targetEntryId, promptId));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("reset");
  });

  it("is not_scheduled for a cardless prompt", async () => {
    const { promptId } = await seedCardlessImport(userA, {
      cueText: "spill the beans",
      answerText: "to reveal a secret"
    });

    expect((await pausePrompt(context.deps, promptId, userA, at(1))).status).toBe("not_scheduled");
    expect((await resumePrompt(context.deps, promptId, userA, at(1))).status).toBe("not_scheduled");
    expect((await restartPrompt(context.deps, promptId, userA, at(1))).status).toBe(
      "not_scheduled"
    );
  });

  it("is not_found for another user's prompt", async () => {
    const promptId = await seedEnrolledPrompt(userB);

    expect((await pausePrompt(context.deps, promptId, userA, at(1))).status).toBe("not_found");
    expect((await resumePrompt(context.deps, promptId, userA, at(1))).status).toBe("not_found");
    expect((await restartPrompt(context.deps, promptId, userA, at(1))).status).toBe("not_found");
  });
});

describe("getNoteReview (#575)", () => {
  it("returns the note and its prompts with card state, oldest first", async () => {
    const noteId = await seedStandaloneNote(userA, t0);
    await enrollNote(
      context.deps,
      noteId,
      userA,
      { cueText: "spill the beans", answerText: "to reveal a secret" },
      at(1)
    );

    const review = await getNoteReview(context.db, userA, noteId);

    expect(review?.noteId).toBe(noteId);
    expect(review?.prompts).toHaveLength(1);
    expect(review?.prompts[0]?.cardStatus).toBe("active");
  });

  it("is undefined for another user's note", async () => {
    const noteId = await seedStandaloneNote(userB, t0);
    expect(await getNoteReview(context.db, userA, noteId)).toBeUndefined();
  });

  it("is undefined for a mark (a bodyless note is never enrollable)", async () => {
    const markId = await seedMark(userA, t0);
    expect(await getNoteReview(context.db, userA, markId)).toBeUndefined();
  });
});
