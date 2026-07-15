import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyRating, newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  cases,
  chunks,
  domains,
  entries,
  entryLinks,
  memoryPrompts,
  noteAnchors,
  notes,
  personalEntries,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import {
  depositMemory,
  importMemoryBatch,
  recordPromptReview,
  snoozePrompt,
  type MemoryDependencies
} from "./memoryCommands.js";

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

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return { db, deps: buildDeps(db) };
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

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("depositMemory", () => {
  it("atomically writes the note, its ownership facet, prompts, and links (with provenance)", async () => {
    await context.db.insert(entries).values({ id: "source-1", type: "note" });
    await seedChunk("chunk-1");

    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "reader",
        noteText: "spill the beans means to reveal a secret",
        derivedFromEntryId: "source-1",
        prompts: [
          { cueText: "reveal a secret (idiom)", answerText: "spill the beans", chunkId: "chunk-1" },
          { cueText: "no answer yet" }
        ]
      },
      userA,
      t0
    );

    expect(deposit.note.captureSource).toBe("reader");
    expect(deposit.note.bodyText).toBe("spill the beans means to reveal a secret");
    expect(deposit.note.derivedFromEntryId).toBe("source-1");
    expect(deposit.prompts).toHaveLength(2);
    // First prompt has a cue AND an answer -> scheduled with a seeded card; second is answerless -> draft.
    expect(deposit.prompts[0]?.lifecycle).toBe("ready");
    expect(deposit.prompts[0]?.answerText).toBe("spill the beans");
    expect(deposit.prompts[0]?.chunkId).toBe("chunk-1");
    expect(deposit.prompts[0]?.review).toEqual(newReviewState(t0));
    expect(deposit.prompts[1]?.lifecycle).toBe("draft");
    expect(deposit.prompts[1]?.answerText).toBeNull();
    expect(deposit.prompts[1]?.review).toBeNull();

    // The note is a first-class owned Entry: exactly one personal_entries facet, carrying chronology.
    const ownership = await context.db
      .select()
      .from(personalEntries)
      .where(eq(personalEntries.entryId, deposit.note.noteId));
    expect(ownership).toHaveLength(1);
    expect(ownership[0]?.userId).toBe(userA);
    expect(ownership[0]?.occurredAt).toEqual(t0);

    // The Memory note now lives in the unified `notes` facet (kind='note'), unanchored (no source
    // anchor), carrying the body + capture source that used to live in the dropped `memory_notes` table.
    const noteRows = await context.db
      .select()
      .from(notes)
      .where(eq(notes.entryId, deposit.note.noteId));
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]?.kind).toBe("note");
    expect(noteRows[0]?.captureSource).toBe("reader");
    expect(noteRows[0]?.bodyText).toBe("spill the beans means to reveal a secret");
    const anchorRows = await context.db
      .select()
      .from(noteAnchors)
      .where(eq(noteAnchors.noteEntryId, deposit.note.noteId));
    expect(anchorRows).toHaveLength(0);

    // entries: the note is a unified `note` + two memory_prompt rows.
    const entryRows = await context.db.select().from(entries);
    const byId = new Map(entryRows.map((row) => [row.id, row.type]));
    expect(byId.get(deposit.note.noteId)).toBe("note");
    expect(byId.get(deposit.prompts[0]!.promptId)).toBe("memory_prompt");
    expect(byId.get(deposit.prompts[1]!.promptId)).toBe("memory_prompt");

    // Links: a derived_from provenance link + one contains link per prompt.
    const links = await context.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.fromEntryId, deposit.note.noteId));
    const linkPairs = links.map((row) => `${row.type}:${row.toEntryId}`).sort();
    expect(linkPairs).toEqual(
      [
        `contains:${deposit.prompts[0]!.promptId}`,
        `contains:${deposit.prompts[1]!.promptId}`,
        "derived_from:source-1"
      ].sort()
    );
  });

  it("writes no provenance link when no source entry is given", async () => {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "manual",
        noteText: "standalone",
        prompts: [{ cueText: "q", answerText: "a" }]
      },
      userA,
      t0
    );

    expect(deposit.note.derivedFromEntryId).toBeNull();
    const links = await context.db
      .select()
      .from(entryLinks)
      .where(eq(entryLinks.fromEntryId, deposit.note.noteId));
    expect(links.every((row) => row.type !== "derived_from")).toBe(true);
  });
});

describe("depositMemory answer resolution (#526/#595)", () => {
  it("suggests a draft's answer from the offline glosser, scheduling the prompt", async () => {
    const seen: string[] = [];
    const deps = buildDeps(context.db, async (text) => {
      seen.push(text);
      return "to reveal a secret";
    });

    const deposit = await depositMemory(
      deps,
      {
        captureSource: "reader",
        noteText: "spill it",
        prompts: [{ cueText: "spill it", glossTerm: "spill it" }]
      },
      userA,
      t0
    );

    expect(seen).toEqual(["spill it"]);
    expect(deposit.prompts[0]?.lifecycle).toBe("ready");
    expect(deposit.prompts[0]?.answerText).toBe("to reveal a secret");
  });

  it("keeps the prompt a draft when the glosser does not know the term", async () => {
    const deps = buildDeps(context.db, async () => null);

    const deposit = await depositMemory(
      deps,
      {
        captureSource: "reader",
        noteText: "x",
        prompts: [{ cueText: "unknownium", glossTerm: "unknownium" }]
      },
      userA,
      t0
    );

    expect(deposit.prompts[0]?.lifecycle).toBe("draft");
    expect(deposit.prompts[0]?.answerText).toBeNull();
  });

  it("prefers a supplied answer and never calls the glosser", async () => {
    const seen: string[] = [];
    const deps = buildDeps(context.db, async (text) => {
      seen.push(text);
      return "autofilled";
    });

    const deposit = await depositMemory(
      deps,
      {
        captureSource: "manual",
        noteText: "x",
        prompts: [{ cueText: "cue", answerText: "my own answer", glossTerm: "cue" }]
      },
      userA,
      t0
    );

    expect(deposit.prompts[0]?.answerText).toBe("my own answer");
    expect(seen).toEqual([]);
  });

  it("does not call the glosser when glossTerm is null", async () => {
    const seen: string[] = [];
    const deps = buildDeps(context.db, async (text) => {
      seen.push(text);
      return "autofilled";
    });

    const deposit = await depositMemory(
      deps,
      { captureSource: "manual", noteText: "x", prompts: [{ cueText: "cue", glossTerm: null }] },
      userA,
      t0
    );

    expect(deposit.prompts[0]?.lifecycle).toBe("draft");
    expect(seen).toEqual([]);
  });

  it("does not call the glosser when no glossTerm is present", async () => {
    const seen: string[] = [];
    const deps = buildDeps(context.db, async (text) => {
      seen.push(text);
      return "autofilled";
    });

    const deposit = await depositMemory(
      deps,
      { captureSource: "manual", noteText: "x", prompts: [{ cueText: "cue" }] },
      userA,
      t0
    );

    expect(deposit.prompts[0]?.lifecycle).toBe("draft");
    expect(seen).toEqual([]);
  });

  it("leaves the answer null when no glosser is wired", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "reader", noteText: "x", prompts: [{ cueText: "cue", glossTerm: "cue" }] },
      userA,
      t0
    );

    expect(deposit.prompts[0]?.lifecycle).toBe("draft");
    expect(deposit.prompts[0]?.answerText).toBeNull();
  });
});

describe("importMemoryBatch (#574)", () => {
  it("atomically imports every draft as a Memory note, in pasted order, owned by the user", async () => {
    const imported = await importMemoryBatch(
      context.deps,
      [
        { captureSource: "import", noteText: "per", prompts: [{ cueText: "per" }] },
        {
          captureSource: "import",
          noteText: "push back\n\npushback",
          prompts: [{ cueText: "push back", answerText: "pushback" }]
        },
        { captureSource: "import", noteText: "diem", prompts: [{ cueText: "diem" }] }
      ],
      userA,
      t0
    );

    expect(imported.map((deposit) => deposit.note.bodyText)).toEqual([
      "per",
      "push back\n\npushback",
      "diem"
    ]);
    // Answerless terms save as unscheduled drafts; the one with an answer is scheduled.
    expect(imported[0]?.prompts[0]?.lifecycle).toBe("draft");
    expect(imported[1]?.prompts[0]?.lifecycle).toBe("ready");
    expect(imported[1]?.prompts[0]?.answerText).toBe("pushback");
    expect(imported[2]?.prompts[0]?.lifecycle).toBe("draft");

    // Every note is a first-class owned Entry in the unified `notes` facet with a personal_entries facet.
    const noteRows = await context.db.select().from(notes);
    expect(noteRows).toHaveLength(3);
    const ownership = await context.db.select().from(personalEntries);
    expect(ownership).toHaveLength(3);
    expect(ownership.every((row) => row.userId === userA)).toBe(true);
    expect(ownership.every((row) => row.occurredAt.getTime() === t0.getTime())).toBe(true);

    const noteEntries = (await context.db.select().from(entries)).filter(
      (row) => row.type === "note"
    );
    expect(noteEntries).toHaveLength(3);
  });

  it("resolves each item's answer through the offline glosser", async () => {
    const seen: string[] = [];
    const deps = buildDeps(context.db, async (text) => {
      seen.push(text);
      return `gloss:${text}`;
    });

    const imported = await importMemoryBatch(
      deps,
      [
        {
          captureSource: "import",
          noteText: "alpha",
          prompts: [{ cueText: "alpha", glossTerm: "alpha" }]
        },
        {
          captureSource: "import",
          noteText: "beta",
          prompts: [{ cueText: "beta", glossTerm: "beta" }]
        }
      ],
      userA,
      t0
    );

    expect(seen).toEqual(["alpha", "beta"]);
    expect(imported[0]?.prompts[0]?.answerText).toBe("gloss:alpha");
    expect(imported[0]?.prompts[0]?.lifecycle).toBe("ready");
    expect(imported[1]?.prompts[0]?.answerText).toBe("gloss:beta");
  });

  it("persists a supplied rich cue/answer document verbatim, and derives one from text when omitted", async () => {
    const richCue = createTextDocument("push back");
    const richAnswer = createTextDocument("pushback");
    await importMemoryBatch(
      context.deps,
      [
        {
          captureSource: "import",
          noteText: "push back",
          prompts: [
            { cueText: "push back", answerText: "pushback", cueDoc: richCue, answerDoc: richAnswer }
          ]
        },
        { captureSource: "import", noteText: "plain", prompts: [{ cueText: "plain" }] }
      ],
      userA,
      t0
    );

    const rows = await context.db.select().from(memoryPrompts);
    const supplied = rows.find((row) => row.cueText === "push back");
    const derived = rows.find((row) => row.cueText === "plain");
    // The learner's edited documents are stored as-is.
    expect(supplied?.cueDoc).toEqual(richCue);
    expect(supplied?.answerDoc).toEqual(richAnswer);
    // A plain-text feeder (no supplied doc) still gets a single-block document derived from its text.
    expect(derived?.cueDoc).toEqual(createTextDocument("plain"));
    expect(derived?.answerDoc).toBeNull();
  });

  it("rolls back the whole batch when any item fails, saving nothing", async () => {
    await expect(
      importMemoryBatch(
        context.deps,
        [
          { captureSource: "import", noteText: "saved?", prompts: [{ cueText: "saved?" }] },
          {
            captureSource: "import",
            noteText: "bad",
            // A chunkId with no matching chunk row violates the FK, failing the write mid-batch.
            prompts: [{ cueText: "bad", answerText: "x", chunkId: "missing-chunk" }]
          }
        ],
        userA,
        t0
      )
    ).rejects.toThrow();

    // Atomic: the first item must not have leaked — nothing is saved, so the client keeps the whole paste.
    expect(await context.db.select().from(notes)).toHaveLength(0);
    expect(await context.db.select().from(personalEntries)).toHaveLength(0);
    expect(await context.db.select().from(memoryPrompts)).toHaveLength(0);
    const noteEntries = (await context.db.select().from(entries)).filter(
      (row) => row.type === "note"
    );
    expect(noteEntries).toHaveLength(0);
  });
});

describe("recordPromptReview", () => {
  async function seedScheduled(): Promise<string> {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "practice",
        noteText: "n",
        prompts: [{ cueText: "cue", answerText: "answer" }]
      },
      userA,
      t0
    );
    return deposit.prompts[0]!.promptId;
  }

  it("applies FSRS, persists the new card, and appends a history row", async () => {
    const promptId = await seedScheduled();
    const expected = applyRating(newReviewState(t0), "good", at(1), RECALL_REQUEST_RETENTION);

    const result = await recordPromptReview(context.deps, promptId, "good", userA, at(1));
    if (result.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(result.prompt.review).toEqual(expected);
    expect(result.prompt.review?.reps).toBe(1);

    const history = await context.db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.targetEntryId, promptId));
    expect(history).toHaveLength(1);
    expect(history[0]?.type).toBe("rating");
    expect(history[0]?.rating).toBe("good");
  });

  it("returns not_found for a missing prompt", async () => {
    expect(await recordPromptReview(context.deps, "nope", "good", userA, t0)).toEqual({
      status: "not_found"
    });
  });

  it("returns not_found for another user's prompt and leaves it unchanged", async () => {
    const promptId = await seedScheduled();

    expect(await recordPromptReview(context.deps, promptId, "good", userB, t0)).toEqual({
      status: "not_found"
    });

    const row = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0];
    expect(row?.reps).toBe(0);
  });

  it("returns not_scheduled for a draft prompt", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "n", prompts: [{ cueText: "cue only" }] },
      userA,
      t0
    );

    expect(
      await recordPromptReview(context.deps, deposit.prompts[0]!.promptId, "good", userA, t0)
    ).toEqual({ status: "not_scheduled" });
  });
});

describe("snoozePrompt", () => {
  async function seedScheduled(): Promise<string> {
    const deposit = await depositMemory(
      context.deps,
      {
        captureSource: "practice",
        noteText: "n",
        prompts: [{ cueText: "cue", answerText: "answer" }]
      },
      userA,
      t0
    );
    return deposit.prompts[0]!.promptId;
  }

  it("moves only the due date forward a day, leaving the card state untouched", async () => {
    const promptId = await seedScheduled();

    const result = await snoozePrompt(context.db, userA, promptId, at(3));
    if (result.status !== "snoozed") {
      throw new Error("expected snoozed");
    }
    expect(result.prompt.review).toEqual({ ...newReviewState(t0), due: at(4).toISOString() });

    const row = (
      await context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, promptId))
    )[0];
    expect(row?.dueAt).toEqual(at(4));
    expect(row?.reps).toBe(0);
    expect(row?.state).toBe("new");
  });

  it("returns not_found for a missing prompt", async () => {
    expect(await snoozePrompt(context.db, userA, "nope", t0)).toEqual({ status: "not_found" });
  });

  it("returns not_scheduled for a draft prompt", async () => {
    const deposit = await depositMemory(
      context.deps,
      { captureSource: "manual", noteText: "n", prompts: [{ cueText: "cue only" }] },
      userA,
      t0
    );

    expect(await snoozePrompt(context.db, userA, deposit.prompts[0]!.promptId, t0)).toEqual({
      status: "not_scheduled"
    });
  });
});
