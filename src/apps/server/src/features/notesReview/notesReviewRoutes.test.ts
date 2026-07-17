import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NoteRevealDto, NoteReviewNextDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, memoryPrompts, notes, reviewCards } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { reviewStateColumns } from "../review/reviewCardQueries.js";
import { depositMemory, type MemoryDependencies } from "../memory/memoryCommands.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
  memory: MemoryDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;
let sequence = 0;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = t0;
  const createId = (): string => `id-${(sequence += 1)}`;
  const memory: MemoryDependencies = { createId, db };
  const notesReview: NotesReviewRouteDependencies = { createId, db, now: () => now };

  return {
    db,
    memory,
    server: createServer({ logger: false, notesReview }),
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed one ready legacy prompt (cue + custom answer) whose active card is due at `depositedAt`.
async function seedLegacy(
  cueText: string,
  answerText: string,
  userId: string,
  depositedAt: Date
): Promise<{ promptId: string; noteId: string }> {
  const deposit = await depositMemory(
    context.memory,
    { captureSource: "practice", noteText: cueText, prompts: [{ cueText, answerText }] },
    userId,
    depositedAt
  );
  const prompt = deposit.prompts[0]!;
  return { promptId: prompt.promptId, noteId: prompt.noteId };
}

// Seed a current_note prompt on an existing note: no stored answer, its reveal resolves the live note body.
async function seedCurrentNote(noteId: string, userId: string, dueAt: Date): Promise<string> {
  const promptId = `cn-${(sequence += 1)}`;
  await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
  await context.db.insert(memoryPrompts).values({
    entryId: promptId,
    noteEntryId: noteId,
    cueDoc: createTextDocument(`cue:${promptId}`),
    cueText: `cue:${promptId}`,
    answerDoc: null,
    answerText: null,
    lifecycle: "ready",
    revealKind: "current_note",
    chunkId: null,
    createdAt: dueAt
  });
  await context.db.insert(reviewCards).values({
    ...reviewStateColumns(newReviewState(dueAt)),
    targetEntryId: promptId,
    userId,
    status: "active",
    requestedRetention: RECALL_REQUEST_RETENTION
  });
  return promptId;
}

async function pauseCard(targetEntryId: string): Promise<void> {
  await context.db
    .update(reviewCards)
    .set({ status: "paused" })
    .where(eq(reviewCards.targetEntryId, targetEntryId));
}

async function getNext(): Promise<NoteReviewNextDto> {
  const response = await context.server.inject({ method: "GET", url: "/api/notes/review/next" });
  expect(response.statusCode).toBe(200);
  return response.json() as NoteReviewNextDto;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("GET /api/notes/review/next", () => {
  it("returns a null prompt as the calm due-complete state when nothing is due", async () => {
    context.setNow(at(0));
    await seedLegacy("later", "answer:later", DEFAULT_USER_ID, at(5));
    expect(await getNext()).toEqual({ prompt: null });
  });

  it("presents the earliest-due owned prompt as a question, without its answer", async () => {
    context.setNow(at(0));
    await seedLegacy("second", "answer:second", DEFAULT_USER_ID, at(-1));
    const earliest = await seedLegacy("first", "answer:first", DEFAULT_USER_ID, at(-3));
    await seedLegacy("theirs", "answer:theirs", otherUser, at(-5));

    const { prompt } = await getNext();
    expect(prompt?.promptId).toBe(earliest.promptId);
    expect(prompt?.revealKind).toBe("legacy_custom");
    expect(prompt?.cueText).toBe("first");
    expect(JSON.stringify(prompt)).not.toContain("answer:first");
  });

  it("excludes not-yet-due and paused prompts from selection", async () => {
    context.setNow(at(0));
    const paused = await seedLegacy("paused", "answer:paused", DEFAULT_USER_ID, at(-2));
    await pauseCard(paused.promptId);
    await seedLegacy("future", "answer:future", DEFAULT_USER_ID, at(3));
    expect(await getNext()).toEqual({ prompt: null });
  });
});

describe("GET /api/notes/review/prompts/:id/reveal", () => {
  it("reveals a legacy prompt's own preserved custom answer", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("cue", "the custom answer", DEFAULT_USER_ID, at(-1));
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/reveal`
    });
    expect(response.statusCode).toBe(200);
    const reveal = response.json() as NoteRevealDto;
    expect(reveal.kind).toBe("legacy_custom");
    expect(reveal).toMatchObject({ kind: "legacy_custom", answerText: "the custom answer" });
  });

  it("reveals a current_note prompt from the note's live canonical body", async () => {
    context.setNow(at(0));
    const { noteId } = await seedLegacy("host", "answer:host", DEFAULT_USER_ID, at(-1));
    const promptId = await seedCurrentNote(noteId, DEFAULT_USER_ID, at(-1));
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/reveal`
    });
    expect(response.statusCode).toBe(200);
    const reveal = response.json() as NoteRevealDto;
    expect(reveal.kind).toBe("current_note");
    expect(reveal).toMatchObject({ kind: "current_note", bodyText: "host" });
  });

  it("404s for another user's prompt", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("theirs", "answer:theirs", otherUser, at(-1));
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/reveal`
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a paused prompt (no active card is revealable)", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("paused", "answer:paused", DEFAULT_USER_ID, at(-1));
    await pauseCard(promptId);
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/reveal`
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an unknown prompt id", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/notes/review/prompts/missing/reveal"
    });
    expect(response.statusCode).toBe(404);
  });

  it("resolves a current_note reveal from the note's live body, tracking an edit in place", async () => {
    context.setNow(at(0));
    const { noteId } = await seedLegacy("original body", "answer:host", DEFAULT_USER_ID, at(-1));
    const promptId = await seedCurrentNote(noteId, DEFAULT_USER_ID, at(-1));

    const before = (
      await context.server.inject({
        method: "GET",
        url: `/api/notes/review/prompts/${promptId}/reveal`
      })
    ).json() as NoteRevealDto;
    expect(before).toMatchObject({ kind: "current_note", bodyText: "original body" });

    // Editing ONLY the note's canonical body must change what the SAME prompt/card reveals next —
    // a current_note prompt owns no snapshot; the note is the single source of truth.
    await context.db
      .update(notes)
      .set({ bodyDoc: createTextDocument("edited body"), bodyText: "edited body" })
      .where(eq(notes.entryId, noteId));

    const after = (
      await context.server.inject({
        method: "GET",
        url: `/api/notes/review/prompts/${promptId}/reveal`
      })
    ).json() as NoteRevealDto;
    expect(after).toMatchObject({ kind: "current_note", bodyText: "edited body" });

    // The prompt and its card are untouched by the note edit: identity and due state are stable.
    const { prompt } = await getNext();
    expect(prompt?.promptId).toBe(promptId);
  });

  it("leaves a legacy prompt's preserved answer unchanged when its note body is edited", async () => {
    context.setNow(at(0));
    const { promptId, noteId } = await seedLegacy(
      "cue",
      "the preserved answer",
      DEFAULT_USER_ID,
      at(-1)
    );

    await context.db
      .update(notes)
      .set({ bodyDoc: createTextDocument("rewritten note"), bodyText: "rewritten note" })
      .where(eq(notes.entryId, noteId));

    const reveal = (
      await context.server.inject({
        method: "GET",
        url: `/api/notes/review/prompts/${promptId}/reveal`
      })
    ).json() as NoteRevealDto;
    expect(reveal).toMatchObject({ kind: "legacy_custom", answerText: "the preserved answer" });
  });
});

describe("POST /api/notes/review/prompts/:id/rating", () => {
  it("reschedules only that prompt's card and returns its next state", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("cue", "answer:cue", DEFAULT_USER_ID, at(-1));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { review: { due: string; state: string } };
    // A "good" rating on a due card advances it beyond now, so it leaves the due batch.
    expect(new Date(body.review.due).getTime()).toBeGreaterThan(at(0).getTime());
    expect(await getNext()).toEqual({ prompt: null });
  });

  it("rejects a malformed rating with 400", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("cue", "answer:cue", DEFAULT_USER_ID, at(-1));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/rating`,
      payload: { rating: "brilliant" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s when rating another user's prompt", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("theirs", "answer:theirs", otherUser, at(-1));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s when rating a prompt that has no card (a draft)", async () => {
    context.setNow(at(0));
    const deposit = await depositMemory(
      context.memory,
      { captureSource: "practice", noteText: "draft", prompts: [{ cueText: "draft cue" }] },
      DEFAULT_USER_ID,
      at(-1)
    );
    const draftPromptId = deposit.prompts[0]!.promptId;
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${draftPromptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(404);
  });
});
