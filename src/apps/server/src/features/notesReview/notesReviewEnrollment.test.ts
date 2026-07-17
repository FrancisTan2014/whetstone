import { PGlite } from "@electric-sql/pglite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NoteDto, NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";

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
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import type { NotesDependencies } from "./../notes/noteCommands.js";
import {
  enrollNoteInReview,
  getNoteReviewStatus,
  projectEnrollmentStatus,
  type NoteReviewEnrollmentDependencies
} from "./notesReviewEnrollment.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";
import { reviewStateColumns, type ReviewCardRow } from "../review/reviewCardQueries.js";
import { newReviewState } from "@whetstone/domain";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
  enrollment: NoteReviewEnrollmentDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;
let sequence = 0;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-enroll-"));

  let now = t0;
  const createId = (): string => `id-${(sequence += 1)}`;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(sequence += 1)}`,
    createEntryId: () => `work-${(sequence += 1)}`,
    db
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(sequence += 1)}`,
    createSourceId: () => `source-${(sequence += 1)}`,
    db,
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  const notes: NotesDependencies = {
    createEntryId: () => `note-${(sequence += 1)}`,
    db,
    now: () => now
  };
  const notesReview: NotesReviewRouteDependencies = { createId, db, now: () => now };

  return {
    db,
    enrollment: { createId, db, now: () => now },
    server: createServer({ content, library, logger: false, notes, notesReview }),
    setNow: (when) => {
      now = when;
    }
  };
}

async function createWorkWithBlock(): Promise<{ blockEntryId: string; workEntryId: string }> {
  const workResponse = await context.server.inject({
    method: "POST",
    payload: {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      title: "Fables",
      workType: "classical_text"
    },
    url: "/api/works"
  });
  const workEntryId = workResponse.json().work.entryId as string;

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox jumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const structure = (
    await context.server.inject({ method: "GET", url: `/api/works/${workEntryId}/structure` })
  ).json() as { readingUnits: ReadonlyArray<{ entryId: string }> };
  const unitId = structure.readingUnits[0]!.entryId;
  const unit = (
    await context.server.inject({
      method: "GET",
      url: `/api/works/${workEntryId}/units/${unitId}/content`
    })
  ).json() as { blocks: ReadonlyArray<{ entryId: string }> };

  return { blockEntryId: unit.blocks[0]!.entryId, workEntryId };
}

async function createNote(workEntryId: string, blockEntryId: string): Promise<NoteDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: {
      anchor: {
        blockEntryId,
        contextSnapshot: "The quick brown fox jumps over the lazy dog.",
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      },
      bodyDoc: createTextDocument("to outwit")
    },
    url: `/api/works/${workEntryId}/notes`
  });
  return response.json() as NoteDto;
}

async function createMark(workEntryId: string, blockEntryId: string): Promise<NoteDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: {
      anchor: {
        blockEntryId,
        contextSnapshot: "The quick brown fox jumps over the lazy dog.",
        endOffset: 19,
        selectedTextSnapshot: "brown fox",
        startOffset: 10
      }
    },
    url: `/api/works/${workEntryId}/marks`
  });
  return response.json() as NoteDto;
}

function enroll(
  workEntryId: string,
  noteEntryId: string
): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "POST",
    url: `/api/works/${workEntryId}/notes/${noteEntryId}/review/enrollment`
  });
}

function status(
  workEntryId: string,
  noteEntryId: string
): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/notes/${noteEntryId}/review`
  });
}

// The owner-scoped Notes-home enrollment/status routes (#659): non-work-scoped, so a standalone note is
// reachable. A bodyless POST sends no payload (Fastify rejects an empty JSON body), so the route reads
// `request.body ?? {}`.
function ownerEnroll(
  noteEntryId: string,
  body?: unknown
): ReturnType<typeof context.server.inject> {
  return context.server.inject(
    body === undefined
      ? { method: "POST", url: `/api/notes/${noteEntryId}/review/enrollment` }
      : { method: "POST", payload: body, url: `/api/notes/${noteEntryId}/review/enrollment` }
  );
}

function ownerStatus(noteEntryId: string): ReturnType<typeof context.server.inject> {
  return context.server.inject({ method: "GET", url: `/api/notes/${noteEntryId}/review` });
}

async function createStandaloneNote(bodyText: string): Promise<NoteDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { bodyDoc: createTextDocument(bodyText) },
    url: "/api/notes"
  });
  return response.json() as NoteDto;
}

async function promptRowsFor(
  noteEntryId: string
): Promise<ReadonlyArray<typeof memoryPrompts.$inferSelect>> {
  return context.db.select().from(memoryPrompts).where(eq(memoryPrompts.noteEntryId, noteEntryId));
}

async function cardsFor(targetEntryId: string): Promise<ReadonlyArray<ReviewCardRow>> {
  return context.db.select().from(reviewCards).where(eq(reviewCards.targetEntryId, targetEntryId));
}

async function updatedAtOf(noteEntryId: string): Promise<Date> {
  const rows = await context.db
    .select({ updatedAt: personalEntries.updatedAt })
    .from(personalEntries)
    .where(eq(personalEntries.entryId, noteEntryId));
  return rows[0]!.updatedAt;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("projectEnrollmentStatus", () => {
  it("maps a missing card, a paused card, a due card, and a future card", () => {
    const base: ReviewCardRow = {
      ...reviewStateColumns(newReviewState(at(0))),
      targetEntryId: "t",
      userId: DEFAULT_USER_ID,
      status: "active",
      requestedRetention: RECALL_REQUEST_RETENTION,
      dueAt: at(0),
      createdAt: at(0),
      updatedAt: at(0)
    };
    expect(projectEnrollmentStatus(undefined, at(0))).toEqual({ status: "not_enrolled" });
    expect(projectEnrollmentStatus({ ...base, status: "paused" }, at(0))).toEqual({
      status: "paused"
    });
    expect(projectEnrollmentStatus({ ...base, dueAt: at(-1) }, at(0))).toEqual({ status: "due" });
    expect(projectEnrollmentStatus({ ...base, dueAt: at(2) }, at(0))).toEqual({
      status: "scheduled",
      nextReviewAt: at(2).toISOString()
    });
  });
});

describe("POST .../review/enrollment", () => {
  it("creates exactly one current_note prompt and one active card due now, with no answer or event", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    const before = await updatedAtOf(note.entryId);
    context.setNow(at(1));

    const response = await enroll(workEntryId, note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    // The question is the exact anchor snapshot; no answer is copied from the note body.
    expect(prompt.revealKind).toBe("current_note");
    expect(prompt.cueText).toBe("brown fox");
    expect(prompt.answerDoc).toBeNull();
    expect(prompt.answerText).toBeNull();

    // One active shared card, at the recall retention, due at enrollment time; no review event.
    const cards = await cardsFor(prompt.entryId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("active");
    expect(cards[0]!.requestedRetention).toBe(RECALL_REQUEST_RETENTION);
    expect(cards[0]!.dueAt).toEqual(at(1));
    const events = await context.db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.targetEntryId, prompt.entryId));
    expect(events).toHaveLength(0);

    // The note→prompt relationship exists, and enrollment touched the note's chronology once.
    const links = await context.db
      .select()
      .from(entryLinks)
      .where(
        and(eq(entryLinks.fromEntryId, note.entryId), eq(entryLinks.toEntryId, prompt.entryId))
      );
    expect(links).toHaveLength(1);
    expect((await updatedAtOf(note.entryId)).getTime()).toBeGreaterThan(before.getTime());
  });

  it("is idempotent: a second enrollment reuses the prompt and card and does not re-touch the note", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);

    await enroll(workEntryId, note.entryId);
    const prompts = await promptRowsFor(note.entryId);
    const firstUpdatedAt = await updatedAtOf(note.entryId);

    context.setNow(at(3));
    const second = await enroll(workEntryId, note.entryId);
    expect(second.statusCode).toBe(200);
    expect(second.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    // Still exactly one prompt and one card — the same rows — and no chronology change on the re-submit.
    const promptsAfter = await promptRowsFor(note.entryId);
    expect(promptsAfter).toHaveLength(1);
    expect(promptsAfter[0]!.entryId).toBe(prompts[0]!.entryId);
    expect(await cardsFor(prompts[0]!.entryId)).toHaveLength(1);
    expect((await updatedAtOf(note.entryId)).getTime()).toBe(firstUpdatedAt.getTime());
  });

  it("reuses an existing cardless current_note prompt and seeds one card for it", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);

    // A current_note prompt already exists (e.g. seeded then its card removed) but has no card.
    const promptId = "preexisting-prompt";
    await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await context.db.insert(memoryPrompts).values({
      entryId: promptId,
      noteEntryId: note.entryId,
      cueDoc: createTextDocument("brown fox"),
      cueText: "brown fox",
      answerDoc: null,
      answerText: null,
      lifecycle: "ready",
      revealKind: "current_note",
      chunkId: null,
      createdAt: at(0)
    });

    const response = await enroll(workEntryId, note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.entryId).toBe(promptId);
    expect(await cardsFor(promptId)).toHaveLength(1);
  });

  it("returns the paused state without resetting the schedule when the card is already paused", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    await enroll(workEntryId, note.entryId);
    const prompt = (await promptRowsFor(note.entryId))[0]!;
    await context.db
      .update(reviewCards)
      .set({ status: "paused", dueAt: at(9) })
      .where(eq(reviewCards.targetEntryId, prompt.entryId));

    const response = await enroll(workEntryId, note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "paused" });
    // The paused card is untouched: still one card, still paused, still its future due date.
    const cards = await cardsFor(prompt.entryId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("paused");
    expect(cards[0]!.dueAt).toEqual(at(9));
  });

  it("409s when the note is a Mark (never a retrieval target)", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId);
    const response = await enroll(workEntryId, mark.entryId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "not_enrollable" });
    expect(await promptRowsFor(mark.entryId)).toHaveLength(0);
  });

  it("404s for an unknown note, another user's note, and a wrong-work note", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);

    expect((await enroll(workEntryId, "missing")).statusCode).toBe(404);

    await context.db
      .update(personalEntries)
      .set({ userId: otherUser })
      .where(eq(personalEntries.entryId, note.entryId));
    expect((await enroll(workEntryId, note.entryId)).statusCode).toBe(404);

    const other = await createWorkWithBlock();
    expect((await enroll(other.workEntryId, note.entryId)).statusCode).toBe(404);
  });

  it("does not change the prompt or card when the note body is later edited", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    await enroll(workEntryId, note.entryId);
    const prompt = (await promptRowsFor(note.entryId))[0]!;
    const card = (await cardsFor(prompt.entryId))[0]!;

    context.setNow(at(4));
    await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: createTextDocument("a rewritten note body") },
      url: `/api/works/${workEntryId}/notes/${note.entryId}`
    });

    const promptAfter = (await promptRowsFor(note.entryId))[0]!;
    const cardAfter = (await cardsFor(prompt.entryId))[0]!;
    expect(promptAfter.entryId).toBe(prompt.entryId);
    expect(promptAfter.cueText).toBe(prompt.cueText);
    expect(cardAfter.dueAt).toEqual(card.dueAt);
    expect(cardAfter.requestedRetention).toBe(card.requestedRetention);
    expect(cardAfter.status).toBe(card.status);
  });
});

describe("GET .../review", () => {
  it("reports not_enrolled for a saved note that has no current_note prompt", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    const response = await status(workEntryId, note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "not_enrolled" });
  });

  it("reports not_enrolled when a current_note prompt exists but has no card", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    const promptId = "cardless-prompt";
    await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await context.db.insert(memoryPrompts).values({
      entryId: promptId,
      noteEntryId: note.entryId,
      cueDoc: createTextDocument("brown fox"),
      cueText: "brown fox",
      answerDoc: null,
      answerText: null,
      lifecycle: "ready",
      revealKind: "current_note",
      chunkId: null,
      createdAt: at(0)
    });
    const response = await status(workEntryId, note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "not_enrolled" });
  });

  it("reports due after enrollment, and scheduled once the card's due date is in the future", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    await enroll(workEntryId, note.entryId);
    expect(
      (await status(workEntryId, note.entryId)).json() as NoteReviewEnrollmentStatusDto
    ).toEqual({ status: "due" });

    const prompt = (await promptRowsFor(note.entryId))[0]!;
    await context.db
      .update(reviewCards)
      .set({ dueAt: at(5) })
      .where(eq(reviewCards.targetEntryId, prompt.entryId));
    expect(
      (await status(workEntryId, note.entryId)).json() as NoteReviewEnrollmentStatusDto
    ).toEqual({ status: "scheduled", nextReviewAt: at(5).toISOString() });
  });

  it("404s for a Mark, an unknown note, and another user's note", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId);
    expect((await status(workEntryId, mark.entryId)).statusCode).toBe(404);
    expect((await status(workEntryId, "missing")).statusCode).toBe(404);

    const note = await createNote(workEntryId, blockEntryId);
    await context.db
      .update(personalEntries)
      .set({ userId: otherUser })
      .where(eq(personalEntries.entryId, note.entryId));
    expect((await status(workEntryId, note.entryId)).statusCode).toBe(404);
  });
});

describe("current_note prompt uniqueness", () => {
  it("rejects a second current_note prompt for the same note at the database", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    await enroll(workEntryId, note.entryId);

    await context.db.insert(entries).values({ id: "dup-prompt", type: "memory_prompt" });
    await expect(
      context.db.insert(memoryPrompts).values({
        entryId: "dup-prompt",
        noteEntryId: note.entryId,
        cueDoc: createTextDocument("brown fox"),
        cueText: "brown fox",
        answerDoc: null,
        answerText: null,
        lifecycle: "ready",
        revealKind: "current_note",
        chunkId: null,
        createdAt: at(0)
      })
    ).rejects.toThrow();
  });
});

describe("enrollNoteInReview (direct)", () => {
  it("serializes two concurrent enrollments into one prompt and one card", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);

    const [a, b] = await Promise.all([
      enrollNoteInReview(
        context.enrollment,
        toEntryId(workEntryId),
        toEntryId(note.entryId),
        DEFAULT_USER_ID
      ),
      enrollNoteInReview(
        context.enrollment,
        toEntryId(workEntryId),
        toEntryId(note.entryId),
        DEFAULT_USER_ID
      )
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    expect(await cardsFor(prompts[0]!.entryId)).toHaveLength(1);
  });

  it("returns not_found for an unanchored note and not_enrollable for a mark", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId);
    expect(
      await enrollNoteInReview(
        context.enrollment,
        toEntryId(workEntryId),
        toEntryId(mark.entryId),
        DEFAULT_USER_ID
      )
    ).toEqual({ status: "not_enrollable" });
    expect(
      (
        await getNoteReviewStatus(
          context.enrollment,
          toEntryId(workEntryId),
          toEntryId("missing"),
          DEFAULT_USER_ID
        )
      ).status
    ).toBe("not_found");
  });
});

describe("owner-scoped enrollment and status (#659)", () => {
  it("enrolls an anchored note using its anchor snapshot, ignoring any supplied question", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);
    const before = await updatedAtOf(note.entryId);
    context.setNow(at(1));

    // A supplied question is ignored for an anchored note — its exact source is the cue.
    const response = await ownerEnroll(note.entryId, { question: "ignore this" });
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.revealKind).toBe("current_note");
    expect(prompts[0]!.cueText).toBe("brown fox");
    expect(prompts[0]!.answerText).toBeNull();
    const cards = await cardsFor(prompts[0]!.entryId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("active");
    expect(cards[0]!.dueAt).toEqual(at(1));
    expect((await updatedAtOf(note.entryId)).getTime()).toBeGreaterThan(before.getTime());
  });

  it("enrolls a bodyless anchored note POST (no supplied question)", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const note = await createNote(workEntryId, blockEntryId);

    const response = await ownerEnroll(note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });
    expect((await promptRowsFor(note.entryId))[0]!.cueText).toBe("brown fox");
  });

  it("enrolls a standalone note with the learner's supplied question", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A free-standing thought.");

    const response = await ownerEnroll(note.entryId, { question: "  What did I mean here?  " });
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.revealKind).toBe("current_note");
    // The supplied question is trimmed and used verbatim as the cue.
    expect(prompts[0]!.cueText).toBe("What did I mean here?");
    expect(await cardsFor(prompts[0]!.entryId)).toHaveLength(1);
  });

  it("400s a standalone enrollment that supplies no question, creating nothing", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A free-standing thought.");

    // A bodyless POST (no question) is a question_required 400 for a standalone note.
    const missing = await ownerEnroll(note.entryId);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "question_required" });

    // A blank question fails the contract at the boundary (invalid_request).
    const blank = await ownerEnroll(note.entryId, { question: "   " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({ error: "invalid_request" });

    expect(await promptRowsFor(note.entryId)).toHaveLength(0);
  });

  it("is idempotent over the owner route: a re-enroll reuses the prompt and card", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A free-standing thought.");
    await ownerEnroll(note.entryId, { question: "What did I mean?" });
    const firstUpdatedAt = await updatedAtOf(note.entryId);
    const prompt = (await promptRowsFor(note.entryId))[0]!;

    context.setNow(at(3));
    const second = await ownerEnroll(note.entryId, { question: "A different question entirely" });
    expect(second.statusCode).toBe(200);
    expect(second.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const promptsAfter = await promptRowsFor(note.entryId);
    expect(promptsAfter).toHaveLength(1);
    expect(promptsAfter[0]!.entryId).toBe(prompt.entryId);
    // The reused prompt keeps its original cue; the re-submit does not re-question or re-touch chronology.
    expect(promptsAfter[0]!.cueText).toBe("What did I mean?");
    expect(await cardsFor(prompt.entryId)).toHaveLength(1);
    expect((await updatedAtOf(note.entryId)).getTime()).toBe(firstUpdatedAt.getTime());
  });

  it("409s a Mark and 404s an unknown or cross-user note over the owner enrollment route", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId);
    const markResponse = await ownerEnroll(mark.entryId, { question: "q" });
    expect(markResponse.statusCode).toBe(409);
    expect(markResponse.json()).toEqual({ error: "not_enrollable" });

    expect((await ownerEnroll("missing", { question: "q" })).statusCode).toBe(404);

    const note = await createNote(workEntryId, blockEntryId);
    await context.db
      .update(personalEntries)
      .set({ userId: otherUser })
      .where(eq(personalEntries.entryId, note.entryId));
    expect((await ownerEnroll(note.entryId)).statusCode).toBe(404);
  });

  it("reports owner-scoped status: not_enrolled, then due after enrollment", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A free-standing thought.");
    expect((await ownerStatus(note.entryId)).json() as NoteReviewEnrollmentStatusDto).toEqual({
      status: "not_enrolled"
    });

    await ownerEnroll(note.entryId, { question: "What did I mean?" });
    expect((await ownerStatus(note.entryId)).json() as NoteReviewEnrollmentStatusDto).toEqual({
      status: "due"
    });
  });

  it("404s owner-scoped status for a Mark, an unknown note, and a cross-user note", async () => {
    context.setNow(at(0));
    const { blockEntryId, workEntryId } = await createWorkWithBlock();
    const mark = await createMark(workEntryId, blockEntryId);
    expect((await ownerStatus(mark.entryId)).statusCode).toBe(404);
    expect((await ownerStatus("missing")).statusCode).toBe(404);

    const note = await createNote(workEntryId, blockEntryId);
    await context.db
      .update(personalEntries)
      .set({ userId: otherUser })
      .where(eq(personalEntries.entryId, note.entryId));
    expect((await ownerStatus(note.entryId)).statusCode).toBe(404);
  });
});

describe("imported note enrollment reuse (#661)", () => {
  // Seed a cardless current-note prompt directly on a standalone note, exactly as an import does: one
  // memory_prompt row + its Entry + the note→prompt `contains` link, with no card or event.
  async function seedImportedPrompt(noteEntryId: string, cueText: string): Promise<string> {
    const promptId = `imported-prompt-${noteEntryId}`;
    await context.db.insert(entries).values({ id: promptId, type: "memory_prompt" });
    await context.db.insert(memoryPrompts).values({
      answerDoc: null,
      answerText: null,
      chunkId: null,
      createdAt: at(0),
      cueDoc: createTextDocument(cueText),
      cueText,
      entryId: promptId,
      lifecycle: "ready",
      noteEntryId,
      revealKind: "current_note"
    });
    await context.db
      .insert(entryLinks)
      .values({ fromEntryId: noteEntryId, toEntryId: promptId, type: "contains" });
    return promptId;
  }

  it("surfaces the imported note's confirmed question on owner status while it stays cardless", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A write-ahead log records changes first.");
    await seedImportedPrompt(note.entryId, "What is a WAL?");

    const body = (await ownerStatus(note.entryId)).json() as NoteReviewEnrollmentStatusDto;
    expect(body).toEqual({ status: "not_enrolled", question: "What is a WAL?" });
  });

  it("reuses the imported prompt's cue on enroll when the learner types no question", async () => {
    context.setNow(at(0));
    const note = await createStandaloneNote("A write-ahead log records changes first.");
    const promptId = await seedImportedPrompt(note.entryId, "What is a WAL?");
    context.setNow(at(1));

    // No typed question: the existing imported prompt's cue is reused, so this is not a question_required.
    const response = await ownerEnroll(note.entryId);
    expect(response.statusCode).toBe(200);
    expect(response.json() as NoteReviewEnrollmentStatusDto).toEqual({ status: "due" });

    const prompts = await promptRowsFor(note.entryId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.entryId).toBe(promptId);
    expect(prompts[0]!.cueText).toBe("What is a WAL?");
    const cards = await cardsFor(promptId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.dueAt).toEqual(at(1));
  });
});
