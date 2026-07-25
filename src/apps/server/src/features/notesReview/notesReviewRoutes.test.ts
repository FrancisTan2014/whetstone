import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  NotePromptSettingsListDto,
  NoteRevealDto,
  NoteReviewNextDto,
  ReviewHistoryPageDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { fingerprintNoteMaterial } from "../notes/noteMaterialFingerprint.js";
import { newReviewState, RECALL_REQUEST_RETENTION } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  entries,
  memoryPrompts,
  notes,
  personalEntries,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { reviewStateColumns } from "../review/reviewCardQueries.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
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
  const notesReview: NotesReviewRouteDependencies = { createId, db, now: () => now };

  return {
    db,
    server: createServer({ logger: false, notesReview }),
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed one ready legacy prompt (cue + custom answer) whose active card is due at `depositedAt`, on a
// freshly seeded owned note — the shape the retired Memory deposit used to produce.
async function seedLegacy(
  cueText: string,
  answerText: string,
  userId: string,
  depositedAt: Date
): Promise<{ promptId: string; noteId: string }> {
  const noteId = await seedNote(userId, cueText, depositedAt);
  const promptId = await seedPromptOn({
    noteId,
    cueText,
    answerText,
    createdAt: depositedAt,
    revealKind: "legacy_custom",
    card: { dueAt: depositedAt, status: "active" },
    userId
  });
  return { promptId, noteId };
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

  it("reveals an expected_response prompt as a separate Success check and live Reference", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "the live note body", at(-1));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "expected_response",
      answerText: "names durability + ordering",
      createdAt: at(-1),
      card: { dueAt: at(-1), status: "active" }
    });
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/reveal`
    });
    expect(response.statusCode).toBe(200);
    const reveal = response.json() as NoteRevealDto;
    expect(reveal).toMatchObject({
      kind: "expected_response",
      successCheckText: "names durability + ordering",
      referenceText: "the live note body"
    });

    // The Reference tracks the live note: editing the body changes the reveal in place, but the
    // authored Success check is unchanged.
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
    expect(after).toMatchObject({
      kind: "expected_response",
      successCheckText: "names durability + ordering",
      referenceText: "edited body"
    });
  });
});

describe("POST /api/notes/review/prompts/:id/rating", () => {
  it("reschedules only that prompt's card and returns its next state with no remaining due", async () => {
    context.setNow(at(0));
    const { promptId } = await seedLegacy("cue", "answer:cue", DEFAULT_USER_ID, at(-1));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      review: { due: string; state: string };
      remainingDue: number;
    };
    // A "good" rating on a due card advances it beyond now, so it leaves the due batch.
    expect(new Date(body.review.due).getTime()).toBeGreaterThan(at(0).getTime());
    // It was the only due prompt, so nothing remains — the session can close out immediately.
    expect(body.remainingDue).toBe(0);
    expect(await getNext()).toEqual({ prompt: null });
  });

  it("reports the still-due count when other prompts remain due after a rating", async () => {
    context.setNow(at(0));
    const first = await seedLegacy("first", "answer:first", DEFAULT_USER_ID, at(-3));
    await seedLegacy("second", "answer:second", DEFAULT_USER_ID, at(-2));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${first.promptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { remainingDue: number };
    // The second prompt is still due, so the session keeps offering "review next".
    expect(body.remainingDue).toBe(1);
    // Another user's due prompt never counts toward this learner's remaining batch.
    await seedLegacy("theirs", "answer:theirs", otherUser, at(-1));
    const afterOther = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${first.promptId}/rating`,
      payload: { rating: "good" }
    });
    expect((afterOther.json() as { remainingDue: number }).remainingDue).toBe(1);
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
    const noteId = await seedNote(DEFAULT_USER_ID, "draft", at(-1));
    const draftPromptId = await seedPromptOn({
      noteId,
      cueText: "draft cue",
      createdAt: at(-1)
    });
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${draftPromptId}/rating`,
      payload: { rating: "good" }
    });
    expect(response.statusCode).toBe(404);
  });
});

// Seed a bare owned note (or Mark) directly, so a settings test controls the note's kind, owner, and
// chronology without going through Memory deposit.
async function seedNote(
  userId: string,
  bodyText: string,
  when: Date,
  kind: "note" | "mark" = "note"
): Promise<string> {
  const noteId = `note-${(sequence += 1)}`;
  await context.db.insert(entries).values({ id: noteId, type: "note" });
  await context.db.insert(notes).values({
    entryId: noteId,
    kind,
    bodyDoc: kind === "note" ? createTextDocument(bodyText) : null,
    bodyText: kind === "note" ? bodyText : null,
    captureSource: "manual",
    materialFingerprint:
      kind === "note" ? fingerprintNoteMaterial(createTextDocument(bodyText)) : null
  });
  await context.db
    .insert(personalEntries)
    .values({ entryId: noteId, userId, occurredAt: when, createdAt: when, updatedAt: when });
  return noteId;
}

// Insert one prompt on an existing note with full control over its reveal kind, creation time, and card.
async function seedPromptOn(options: {
  noteId: string;
  cueText: string;
  createdAt: Date;
  revealKind?: "current_note" | "expected_response" | "legacy_custom";
  answerText?: string;
  card?: { dueAt: Date; status: "active" | "paused" };
  userId?: string;
}): Promise<string> {
  const promptId = `p-${(sequence += 1)}`;
  const revealKind = options.revealKind ?? "legacy_custom";
  const hasAnswer = revealKind === "legacy_custom" || revealKind === "expected_response";
  await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
  await context.db.insert(memoryPrompts).values({
    entryId: promptId,
    noteEntryId: options.noteId,
    cueDoc: createTextDocument(options.cueText),
    cueText: options.cueText,
    answerDoc: hasAnswer ? createTextDocument(options.answerText ?? "answer") : null,
    answerText: hasAnswer ? (options.answerText ?? "answer") : null,
    lifecycle: "ready",
    revealKind,
    chunkId: null,
    createdAt: options.createdAt
  });
  if (options.card !== undefined) {
    await context.db.insert(reviewCards).values({
      ...reviewStateColumns(newReviewState(options.card.dueAt)),
      targetEntryId: promptId,
      userId: options.userId ?? DEFAULT_USER_ID,
      status: options.card.status,
      requestedRetention: RECALL_REQUEST_RETENTION
    });
  }
  return promptId;
}

async function getSettings(noteId: string): Promise<NotePromptSettingsListDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/notes/${noteId}/review/settings`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as NotePromptSettingsListDto;
}

async function cardStatusOf(promptId: string): Promise<string | undefined> {
  const rows = await context.db
    .select({ status: reviewCards.status })
    .from(reviewCards)
    .where(eq(reviewCards.targetEntryId, promptId));
  return rows[0]?.status;
}

async function countEvents(promptId: string): Promise<number> {
  const rows = await context.db
    .select({ id: reviewEvents.id })
    .from(reviewEvents)
    .where(eq(reviewEvents.targetEntryId, promptId));
  return rows.length;
}

describe("GET /api/notes/:noteEntryId/review/settings", () => {
  it("lists every prompt in creation order with its reveal policy and projected card state", async () => {
    context.setNow(at(3));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-2));
    const due = await seedPromptOn({
      noteId,
      cueText: "due legacy",
      answerText: "legacy answer",
      createdAt: at(-1),
      card: { dueAt: at(-1), status: "active" }
    });
    const scheduled = await seedPromptOn({
      noteId,
      cueText: "scheduled current",
      revealKind: "current_note",
      createdAt: at(0),
      card: { dueAt: at(5), status: "active" }
    });
    const paused = await seedPromptOn({
      noteId,
      cueText: "paused legacy",
      answerText: "paused answer",
      createdAt: at(1),
      card: { dueAt: at(-1), status: "paused" }
    });
    const cardless = await seedPromptOn({
      noteId,
      cueText: "cardless legacy",
      answerText: "cardless answer",
      createdAt: at(2)
    });

    const body = await getSettings(noteId);
    expect(body.prompts.map((prompt) => prompt.promptId)).toEqual([
      due,
      scheduled,
      paused,
      cardless
    ]);
    expect(body.prompts[0]).toMatchObject({
      questionText: "due legacy",
      reveal: { kind: "legacy_custom", answerText: "legacy answer" },
      cardState: { state: "due" }
    });
    expect(body.prompts[1]).toMatchObject({
      questionText: "scheduled current",
      reveal: { kind: "current_note" },
      cardState: { state: "scheduled", nextReviewAt: at(5).toISOString() }
    });
    expect(body.prompts[2]?.cardState).toEqual({ state: "paused" });
    expect(body.prompts[3]?.cardState).toEqual({ state: "not_in_review" });
    // A current_note reveal never carries answer content — its reveal is the live note body.
    expect(JSON.stringify(body.prompts[1]?.reveal)).not.toContain("answer");
  });

  it("404s when the note is not the caller's", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(otherUser, "theirs", at(-1));
    await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/${noteId}/review/settings`
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s when the note is a Mark (never a retrieval target)", async () => {
    context.setNow(at(0));
    const markId = await seedNote(DEFAULT_USER_ID, "", at(-1), "mark");
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/${markId}/review/settings`
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an unknown note id", async () => {
    context.setNow(at(0));
    const response = await context.server.inject({
      method: "GET",
      url: "/api/notes/missing/review/settings"
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/notes/review/prompts/:id/history", () => {
  async function seedEvents(
    promptId: string,
    events: ReadonlyArray<{ id: string; type: "rating" | "reset"; rating?: string; at: Date }>
  ): Promise<void> {
    for (const event of events) {
      await context.db.insert(reviewEvents).values({
        id: event.id,
        targetEntryId: promptId,
        type: event.type,
        rating: event.type === "rating" ? (event.rating as "good") : null,
        occurredAt: event.at
      });
    }
  }

  async function getHistory(promptId: string, cursor?: string): Promise<ReviewHistoryPageDto> {
    const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/history${suffix}`
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ReviewHistoryPageDto;
  }

  it("returns rating and reset events newest first, with no fabricated entries", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    await seedEvents(promptId, [
      { id: "ev-1", type: "rating", rating: "again", at: at(-3) },
      { id: "ev-2", type: "reset", at: at(-2) },
      { id: "ev-3", type: "rating", rating: "good", at: at(-1) }
    ]);
    const page = await getHistory(promptId);
    expect(page.nextCursor).toBeNull();
    expect(page.events).toEqual([
      { id: "ev-3", kind: "rating", rating: "good", occurredAt: at(-1).toISOString() },
      { id: "ev-2", kind: "reset", occurredAt: at(-2).toISOString() },
      { id: "ev-1", kind: "rating", rating: "again", occurredAt: at(-3).toISOString() }
    ]);
  });

  it("returns an empty page for a prompt with no history", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    expect(await getHistory(promptId)).toEqual({ events: [], nextCursor: null });
  });

  it("pages newest-first with an opaque cursor and a stable id tiebreak", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-30));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-30),
      card: { dueAt: at(-1), status: "active" }
    });
    // 25 events; two share an occurred_at to exercise the id tiebreak.
    const events = Array.from({ length: 25 }, (_, index) => ({
      id: `ev-${String(index).padStart(2, "0")}`,
      type: "rating" as const,
      rating: "good",
      at: at(-25 + index)
    }));
    events[10] = { ...events[10]!, at: events[9]!.at };
    await seedEvents(promptId, events);

    const first = await getHistory(promptId);
    expect(first.events).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    // Newest first: ev-24 (at -1) leads.
    expect(first.events[0]?.id).toBe("ev-24");

    const second = await getHistory(promptId, first.nextCursor!);
    expect(second.events).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    // No event appears on both pages, and the tied pair keeps a deterministic order.
    const firstIds = new Set(first.events.map((event) => event.id));
    for (const event of second.events) {
      expect(firstIds.has(event.id)).toBe(false);
    }
  });

  it("404s for another user's prompt", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(otherUser, "theirs", at(-1));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-1),
      userId: otherUser
    });
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/history`
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s on a malformed cursor (no separator)", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/history?cursor=zzzz`
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s on a cursor whose date is not parseable", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const cursor = Buffer.from("notadate|ev-1", "utf8").toString("base64url");
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/history?cursor=${encodeURIComponent(cursor)}`
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s on a cursor with an empty id", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const cursor = Buffer.from(`${at(-1).toISOString()}|`, "utf8").toString("base64url");
    const response = await context.server.inject({
      method: "GET",
      url: `/api/notes/review/prompts/${promptId}/history?cursor=${encodeURIComponent(cursor)}`
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps a prompt's history after its card is removed", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    await seedEvents(promptId, [{ id: "ev-1", type: "rating", rating: "good", at: at(-1) }]);
    const removal = await context.server.inject({
      method: "DELETE",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    expect(removal.statusCode).toBe(200);
    // History outlives the card, so the record still reads for the now-cardless prompt.
    const page = await getHistory(promptId);
    expect(page.events).toHaveLength(1);
  });
});

describe("PATCH /api/notes/review/prompts/:id/question", () => {
  it("edits only the cue, preserving the card, its due state, and its history", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "old question",
      answerText: "kept answer",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    await context.db.insert(reviewEvents).values({
      id: "ev-1",
      targetEntryId: promptId,
      type: "rating",
      rating: "good",
      occurredAt: at(-2)
    });
    const before = await context.db
      .select({ dueAt: reviewCards.dueAt })
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, promptId));

    const response = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: { expectedRevision: 0, questionDoc: createTextDocument("new question") }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      questionText: "new question",
      reveal: { kind: "legacy_custom", answerText: "kept answer" },
      cardState: { state: "due" }
    });

    const after = await context.db
      .select({ cueText: memoryPrompts.cueText, answerText: memoryPrompts.answerText })
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(after[0]).toEqual({ cueText: "new question", answerText: "kept answer" });
    // The card schedule and history are untouched by a question edit.
    const cardAfter = await context.db
      .select({ dueAt: reviewCards.dueAt })
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, promptId));
    expect(cardAfter[0]?.dueAt).toEqual(before[0]?.dueAt);
    expect(await countEvents(promptId)).toBe(1);
  });

  it("rejects a stale Question revision at the real HTTP/database boundary and preserves the newer edit", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "question loaded by repair",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    const loaded = await context.server.inject({
      method: "GET",
      url: `/api/notes/${noteId}/review/settings`
    });
    const expectedRevision = loaded.json().prompts[0].revision as number;
    expect(expectedRevision).toBe(0);

    const concurrent = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: {
        expectedRevision,
        questionDoc: createTextDocument("newer Question from another editor")
      }
    });
    expect(concurrent.statusCode).toBe(200);
    expect(concurrent.json()).toMatchObject({
      questionText: "newer Question from another editor",
      revision: 1
    });

    const staleRepair = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: {
        expectedRevision,
        questionDoc: createTextDocument("learner's stale repair draft")
      }
    });
    expect(staleRepair.statusCode).toBe(409);
    expect(staleRepair.json()).toEqual({ error: "prompt_conflict" });
    const persisted = await context.db
      .select({ cueText: memoryPrompts.cueText, revision: memoryPrompts.revision })
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(persisted[0]).toEqual({
      cueText: "newer Question from another editor",
      revision: 1
    });
    expect(await countEvents(promptId)).toBe(0);
  });

  it("rejects a blank question with 400", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const response = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: { expectedRevision: 0, questionDoc: createTextDocument("   ") }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_question" });
  });

  it("rejects a malformed body with 400 invalid_request", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-1));
    const promptId = await seedPromptOn({ noteId, cueText: "cue", createdAt: at(-1) });
    const response = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: { expectedRevision: 0, questionDoc: "not a document" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("404s when the prompt is not the caller's", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(otherUser, "theirs", at(-1));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-1),
      userId: otherUser
    });
    const response = await context.server.inject({
      method: "PATCH",
      url: `/api/notes/review/prompts/${promptId}/question`,
      payload: { expectedRevision: 0, questionDoc: createTextDocument("mine now") }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("pause / resume / restart / remove / re-add", () => {
  async function seedActive(dueAt = at(-1)): Promise<string> {
    const noteId = await seedNote(DEFAULT_USER_ID, "body", at(-5));
    return seedPromptOn({
      noteId,
      cueText: "cue",
      answerText: "answer",
      createdAt: at(-5),
      card: { dueAt, status: "active" }
    });
  }

  it("pauses an active card without touching FSRS state or appending an event", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/pause`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cardState: { state: "paused" } });
    expect(await cardStatusOf(promptId)).toBe("paused");
    expect(await countEvents(promptId)).toBe(0);
  });

  it("resumes a paused card back to due, with no event", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/pause`
    });
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/resume`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cardState: { state: "due" } });
    expect(await cardStatusOf(promptId)).toBe("active");
    expect(await countEvents(promptId)).toBe(0);
  });

  it("restarts the schedule, appending exactly one reset event and becoming due now", async () => {
    context.setNow(at(0));
    const promptId = await seedActive(at(5));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/restart`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cardState: { state: "due" } });
    expect(await countEvents(promptId)).toBe(1);
    const events = await context.db
      .select({ type: reviewEvents.type })
      .from(reviewEvents)
      .where(eq(reviewEvents.targetEntryId, promptId));
    expect(events[0]?.type).toBe("reset");
  });

  it("removes the card but keeps the note and appends no event", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    const response = await context.server.inject({
      method: "DELETE",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cardState: { state: "not_in_review" } });
    expect(await cardStatusOf(promptId)).toBeUndefined();
    // The prompt row (and its note) survive removal.
    const prompt = await context.db
      .select({ id: memoryPrompts.entryId })
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(prompt).toHaveLength(1);
  });

  it("re-adds a cardless prompt, reusing the same prompt with a fresh due card and no event", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    await context.server.inject({
      method: "DELETE",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ promptId, cardState: { state: "due" } });
    expect(await cardStatusOf(promptId)).toBe("active");
    expect(await countEvents(promptId)).toBe(0);
    // Exactly one prompt row — re-adding reuses it, never duplicates.
    const prompts = await context.db
      .select({ id: memoryPrompts.entryId })
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(prompts).toHaveLength(1);
  });

  it("409s a card action on a cardless prompt (stale state)", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    await context.server.inject({
      method: "DELETE",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    for (const path of ["pause", "resume", "restart"]) {
      const response = await context.server.inject({
        method: "POST",
        url: `/api/notes/review/prompts/${promptId}/${path}`
      });
      expect(response.statusCode).toBe(409);
    }
    const remove = await context.server.inject({
      method: "DELETE",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    expect(remove.statusCode).toBe(409);
  });

  it("409s re-adding a card to a prompt that already has one", async () => {
    context.setNow(at(0));
    const promptId = await seedActive();
    const response = await context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/card`
    });
    expect(response.statusCode).toBe(409);
  });

  it("404s a settings action on another user's prompt", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(otherUser, "theirs", at(-1));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      createdAt: at(-1),
      userId: otherUser,
      card: { dueAt: at(-1), status: "active" }
    });
    for (const request of [
      { method: "POST" as const, path: "pause" },
      { method: "POST" as const, path: "resume" },
      { method: "POST" as const, path: "restart" },
      { method: "POST" as const, path: "card" },
      { method: "DELETE" as const, path: "card" }
    ]) {
      const response = await context.server.inject({
        method: request.method,
        url: `/api/notes/review/prompts/${promptId}/${request.path}`
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("POST /api/notes/review/prompts/:id/grading-target", () => {
  async function promptRow(
    promptId: string
  ): Promise<{ revealKind: string; answerText: string | null } | undefined> {
    const rows = await context.db
      .select({ revealKind: memoryPrompts.revealKind, answerText: memoryPrompts.answerText })
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    return rows[0];
  }

  async function dueAtOf(promptId: string): Promise<Date | undefined> {
    const rows = await context.db
      .select({ dueAt: reviewCards.dueAt })
      .from(reviewCards)
      .where(eq(reviewCards.targetEntryId, promptId));
    return rows[0]?.dueAt;
  }

  async function post(promptId: string, body: unknown): ReturnType<typeof context.server.inject> {
    return context.server.inject({
      method: "POST",
      url: `/api/notes/review/prompts/${promptId}/grading-target`,
      payload: { expectedRevision: 0, ...(body as Record<string, unknown>) }
    });
  }

  it("keep: converts current_note to an authored Success check, deriving text and leaving the card untouched", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    const dueBefore = await dueAtOf(promptId);

    const response = await post(promptId, {
      mode: "keep",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("names two rules") }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reveal: { kind: "expected_response", successCheckText: "names two rules" },
      cardState: { state: "due" }
    });
    // The policy and its server-derived text are persisted; the card/due/history are untouched.
    expect(await promptRow(promptId)).toEqual({
      revealKind: "expected_response",
      answerText: "names two rules"
    });
    expect(await dueAtOf(promptId)).toEqual(dueBefore);
    expect(await countEvents(promptId)).toBe(0);
  });

  it("keep: converts an expected_response prompt back to current_note, clearing the stored answer", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "expected_response",
      answerText: "old success check",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });

    const response = await post(promptId, { mode: "keep", target: { kind: "current_note" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reveal: { kind: "current_note" } });
    expect(await promptRow(promptId)).toEqual({ revealKind: "current_note", answerText: null });
    expect(await countEvents(promptId)).toBe(0);
  });

  it("restart: saves the policy AND resets the schedule with exactly one reset event, due now", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      card: { dueAt: at(5), status: "active" }
    });

    const response = await post(promptId, {
      mode: "restart",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("names two rules") }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reveal: { kind: "expected_response", successCheckText: "names two rules" },
      cardState: { state: "due" }
    });
    expect(await countEvents(promptId)).toBe(1);
    const events = await context.db
      .select({ type: reviewEvents.type })
      .from(reviewEvents)
      .where(eq(reviewEvents.targetEntryId, promptId));
    expect(events[0]?.type).toBe("reset");
  });

  it("rejects a stale grading-target revision before any overwrite or schedule reset", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      card: { dueAt: at(5), status: "active" }
    });
    const dueBefore = await dueAtOf(promptId);
    const loaded = await context.server.inject({
      method: "GET",
      url: `/api/notes/${noteId}/review/settings`
    });
    const expectedRevision = loaded.json().prompts[0].revision as number;
    expect(expectedRevision).toBe(0);

    const concurrent = await post(promptId, {
      expectedRevision,
      mode: "keep",
      target: {
        kind: "expected_response",
        successCheckDoc: createTextDocument("newer target from another editor")
      }
    });
    expect(concurrent.statusCode).toBe(200);
    expect(concurrent.json()).toMatchObject({
      revision: 1,
      reveal: {
        kind: "expected_response",
        successCheckText: "newer target from another editor"
      }
    });

    const staleRepair = await post(promptId, {
      expectedRevision,
      mode: "restart",
      target: { kind: "current_note" }
    });
    expect(staleRepair.statusCode).toBe(409);
    expect(staleRepair.json()).toEqual({ error: "prompt_conflict" });
    expect(await promptRow(promptId)).toEqual({
      revealKind: "expected_response",
      answerText: "newer target from another editor"
    });
    expect(await dueAtOf(promptId)).toEqual(dueBefore);
    expect(await countEvents(promptId)).toBe(0);
  });

  it("keep: allows a cardless prompt to change policy without fabricating a card", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5)
    });

    const response = await post(promptId, {
      mode: "keep",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("names two rules") }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reveal: { kind: "expected_response" },
      cardState: { state: "not_in_review" }
    });
    expect(await dueAtOf(promptId)).toBeUndefined();
  });

  it("409s a restart on a cardless prompt and leaves its policy unchanged", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5)
    });

    const response = await post(promptId, {
      mode: "restart",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("names two rules") }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "restart_requires_card" });
    expect(await promptRow(promptId)).toEqual({ revealKind: "current_note", answerText: null });
  });

  it("409s any change to a legacy_custom prompt (read-only), leaving it unchanged", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "legacy_custom",
      answerText: "preserved answer",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });

    for (const mode of ["keep", "restart"] as const) {
      const response = await post(promptId, { mode, target: { kind: "current_note" } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "legacy_read_only" });
    }
    expect(await promptRow(promptId)).toEqual({
      revealKind: "legacy_custom",
      answerText: "preserved answer"
    });
    expect(await countEvents(promptId)).toBe(0);
  });

  it("400s a blank Success check, leaving the prompt's policy unchanged", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });

    const response = await post(promptId, {
      mode: "keep",
      target: { kind: "expected_response", successCheckDoc: createTextDocument("   ") }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_success_check" });
    expect(await promptRow(promptId)).toEqual({ revealKind: "current_note", answerText: null });
  });

  it("400s a malformed request body", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(DEFAULT_USER_ID, "note body", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      card: { dueAt: at(-1), status: "active" }
    });
    const response = await post(promptId, { target: { kind: "current_note" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("404s another user's prompt", async () => {
    context.setNow(at(0));
    const noteId = await seedNote(otherUser, "theirs", at(-5));
    const promptId = await seedPromptOn({
      noteId,
      cueText: "cue",
      revealKind: "current_note",
      createdAt: at(-5),
      userId: otherUser,
      card: { dueAt: at(-1), status: "active" }
    });
    const response = await post(promptId, { mode: "keep", target: { kind: "current_note" } });
    expect(response.statusCode).toBe(404);
  });
});
