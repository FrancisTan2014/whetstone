import { PGlite } from "@electric-sql/pglite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateDirectCardRequest } from "@whetstone/contracts";
import { createTextDocument, documentReadableText, documentText } from "@whetstone/document";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  cardCreationReceipts,
  entryLinks,
  memoryPrompts,
  notes,
  personalEntries,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryRouteDependencies } from "../library/libraryRoutes.js";
import { deleteNoteInTx } from "../notes/noteCommands.js";
import type { NotesDependencies } from "../notes/noteCommands.js";
import { deleteReviewCard } from "../review/reviewCardCommands.js";
import {
  createDirectCard,
  prepareDirectCardDraft,
  writeDirectCardInTx,
  type CreateDirectCardDependencies
} from "./createDirectCard.js";
import { useExistingMaterial } from "./reviewMaterialCommands.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";

// What a test may send as a request body -- including shapes the route must reject. `NonNullable`
// because `exactOptionalPropertyTypes` forbids handing `inject` an explicitly `undefined` payload.
type InjectPayload = NonNullable<InjectOptions["payload"]>;

const now = new Date("2026-03-01T08:00:00.000Z");
const later = new Date("2026-03-05T09:30:00.000Z");
const otherUser = "user-other";

type TestContext = Readonly<{
  db: DbClient;
  deps: CreateDirectCardDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;
let sequence = 0;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-direct-card-"));

  let clock = now;
  const createId = (): string => `id-${(sequence += 1)}`;
  const library: LibraryRouteDependencies = {
    createAuthorId: () => `author-${(sequence += 1)}`,
    createEntryId: () => `work-${(sequence += 1)}`,
    db,
    // Work deletion is exercised in library.test.ts; these tests never call DELETE /api/works/:id,
    // so the file-side collaborators fail loudly rather than silently no-op.
    deleteSourceFile: () => Promise.reject(new Error("unexpected deleteSourceFile")),
    logSourceUnlinkFailure: () => {
      throw new Error("unexpected logSourceUnlinkFailure");
    },
    now: () => new Date()
  };
  const content: ContentDependencies = {
    createAuthorId: () => `content-author-${(sequence += 1)}`,
    createEntryId: () => `content-${(sequence += 1)}`,
    createSourceId: () => `source-${(sequence += 1)}`,
    db,
    // These tests never ingest an EPUB; the parser, upload limit, and image store exist only to
    // satisfy the content route wiring, and fail loudly rather than silently no-op if reached.
    epubParser: () => Promise.reject(new Error("unexpected epubParser")),
    epubUploadLimitBytes: 50 * 1024 * 1024,
    imageResourceStore: {
      store: () => Promise.reject(new Error("unexpected imageResourceStore.store"))
    },
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  const noteDeps: NotesDependencies = {
    createEntryId: () => `note-${(sequence += 1)}`,
    db,
    now: () => clock
  };
  const notesReview: NotesReviewRouteDependencies = {
    attemptTtlMs: 30 * 60 * 1000,
    createId,
    db,
    now: () => clock
  };

  return {
    db,
    deps: { attemptTtlMs: 30 * 60 * 1000, createId, db, now: () => clock },
    server: createServer({ content, library, logger: false, notes: noteDeps, notesReview }),
    setNow: (when) => {
      clock = when;
    }
  };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

// A stable, non-blank question/answer pair. `createTextDocument` yields a valid document whose readable
// text is the passed string, so the server-derived projections are predictable.
function questionDoc(text = "Which sorting algorithm is stable and O(n log n)?") {
  return createTextDocument(text);
}
function answerDoc(text = "Merge sort is stable and runs in O(n log n).") {
  return createTextDocument(text);
}
function successCheckDoc(text = "Mentions merge sort and its stability.") {
  return createTextDocument(text);
}
// A structurally valid document whose readable text is only whitespace (so the command's blank gate, not
// the boundary schema, rejects it).
function blankDoc() {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }]
  };
}

function currentNoteRequest(over: Partial<CreateDirectCardRequest> = {}): CreateDirectCardRequest {
  return {
    submissionId: "sub-1",
    questionDoc: questionDoc(),
    answerDoc: answerDoc(),
    target: { kind: "current_note" },
    ...over
  };
}

function expectedResponseRequest(
  over: Partial<CreateDirectCardRequest> = {}
): CreateDirectCardRequest {
  return currentNoteRequest({
    target: { kind: "expected_response", successCheckDoc: successCheckDoc() },
    ...over
  });
}

const listReceipts = (userId = DEFAULT_USER_ID) =>
  context.db.select().from(cardCreationReceipts).where(eq(cardCreationReceipts.userId, userId));
const listNotes = () => context.db.select().from(notes);
const listPrompts = () => context.db.select().from(memoryPrompts);
const listCards = () => context.db.select().from(reviewCards);
const listEvents = () => context.db.select().from(reviewEvents);
const listContains = () =>
  context.db.select().from(entryLinks).where(eq(entryLinks.type, "contains"));

// The transaction handle drizzle passes into `db.transaction`.
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Wrap a transaction so an insert into `failTable` throws — the only way to exercise a mid-transaction
// failure at a specific write step without reaching through a fake abstraction (the command reaches the DB
// only through the real client boundary). Every other operation passes straight through to the real tx.
function txFailingOnInsert(tx: Tx, failTable: PgTable): Tx {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (table: PgTable) => {
          if (table === failTable) {
            throw new Error("injected write failure");
          }
          return target.insert(table);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

// Wrap the database so any transaction fails at the chosen insert step, to prove the whole submission —
// including the receipt — rolls back as one atomic write.
function dbFailingOnInsert(db: DbClient, failTable: PgTable): DbClient {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return <T>(callback: (tx: Tx) => Promise<T>): Promise<T> =>
          target.transaction((tx) => callback(txFailingOnInsert(tx, failTable)));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

describe("createDirectCard", () => {
  it("creates a note, current-note prompt, contains link, and active card due now with no event", async () => {
    const request = currentNoteRequest();
    const result = await createDirectCard(context.deps, DEFAULT_USER_ID, request);

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("expected created");
    }
    expect(result.result.review.due).toBe(now.toISOString());

    const noteRows = await listNotes();
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]).toMatchObject({
      captureSource: "manual",
      entryId: result.result.noteId,
      kind: "note",
      bodyText: documentReadableText(request.answerDoc)
    });

    const promptRows = await listPrompts();
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({
      answerDoc: null,
      answerText: null,
      cueText: documentReadableText(request.questionDoc),
      entryId: result.result.promptId,
      lifecycle: "ready",
      noteEntryId: result.result.noteId,
      revealKind: "current_note"
    });

    const contains = await listContains();
    expect(contains).toEqual([
      expect.objectContaining({
        fromEntryId: result.result.noteId,
        toEntryId: result.result.promptId
      })
    ]);

    const cards = await listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      requestedRetention: RECALL_REQUEST_RETENTION,
      status: "active",
      targetEntryId: result.result.promptId,
      userId: DEFAULT_USER_ID
    });
    expect(cards[0]!.dueAt.getTime()).toBe(now.getTime());

    expect(await listEvents()).toHaveLength(0);

    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      noteEntryId: result.result.noteId,
      promptEntryId: result.result.promptId,
      submissionId: "sub-1",
      userId: DEFAULT_USER_ID
    });
    expect(receipts[0]!.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates an expected-response prompt carrying the server-derived Success check", async () => {
    const check = successCheckDoc("The answer names merge sort and calls it stable.");
    const request = expectedResponseRequest({
      target: { kind: "expected_response", successCheckDoc: check }
    });

    const result = await createDirectCard(context.deps, DEFAULT_USER_ID, request);
    expect(result.status).toBe("created");

    const promptRows = await listPrompts();
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({
      answerDoc: check,
      answerText: documentText(check),
      revealKind: "expected_response"
    });
  });

  it("rejects a blank question before any write", async () => {
    const result = await createDirectCard(context.deps, DEFAULT_USER_ID, {
      submissionId: "sub-blank-q",
      questionDoc: blankDoc() as CreateDirectCardRequest["questionDoc"],
      answerDoc: answerDoc(),
      target: { kind: "current_note" }
    });
    expect(result).toEqual({ status: "invalid_question" });
    expect(await listNotes()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("rejects a blank answer before any write", async () => {
    const result = await createDirectCard(context.deps, DEFAULT_USER_ID, {
      submissionId: "sub-blank-a",
      questionDoc: questionDoc(),
      answerDoc: blankDoc() as CreateDirectCardRequest["answerDoc"],
      target: { kind: "current_note" }
    });
    expect(result).toEqual({ status: "invalid_answer" });
    expect(await listNotes()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("rejects a blank Success check before any write", async () => {
    const result = await createDirectCard(context.deps, DEFAULT_USER_ID, {
      submissionId: "sub-blank-s",
      questionDoc: questionDoc(),
      answerDoc: answerDoc(),
      target: {
        kind: "expected_response",
        successCheckDoc: blankDoc() as CreateDirectCardRequest["questionDoc"]
      }
    });
    expect(result).toEqual({ status: "invalid_success_check" });
    expect(await listNotes()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("returns the original result on an identical retry without writing a second card", async () => {
    const request = currentNoteRequest();
    const first = await createDirectCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("created");

    context.setNow(later);
    const retry = await createDirectCard(context.deps, DEFAULT_USER_ID, request);

    expect(retry).toEqual(first);
    expect(await listReceipts()).toHaveLength(1);
    expect(await listNotes()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);

    // The replayed result still carries the ORIGINAL due instant, not the advanced clock.
    if (retry.status !== "created") {
      throw new Error("expected created");
    }
    expect(retry.result.review.due).toBe(now.toISOString());

    const owner = await context.db
      .select({ updatedAt: personalEntries.updatedAt })
      .from(personalEntries)
      .where(eq(personalEntries.entryId, retry.result.noteId));
    expect(owner[0]!.updatedAt.getTime()).toBe(now.getTime());
  });

  it("reports a conflict when the same submission id carries a changed payload", async () => {
    const first = await createDirectCard(context.deps, DEFAULT_USER_ID, currentNoteRequest());
    expect(first.status).toBe("created");

    const conflict = await createDirectCard(
      context.deps,
      DEFAULT_USER_ID,
      currentNoteRequest({ answerDoc: answerDoc("A different answer entirely.") })
    );

    expect(conflict).toEqual({ status: "conflict" });
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });

  it("isolates owners so the same submission id yields two independent results", async () => {
    const mine = await createDirectCard(context.deps, DEFAULT_USER_ID, currentNoteRequest());
    const theirs = await createDirectCard(context.deps, otherUser, currentNoteRequest());

    expect(mine.status).toBe("created");
    expect(theirs.status).toBe("created");
    if (mine.status !== "created" || theirs.status !== "created") {
      throw new Error("expected created");
    }
    expect(mine.result.noteId).not.toBe(theirs.result.noteId);
    expect(await listNotes()).toHaveLength(2);
    expect(await listCards()).toHaveLength(2);
    expect(await listReceipts(DEFAULT_USER_ID)).toHaveLength(1);
    expect(await listReceipts(otherUser)).toHaveLength(1);
  });

  it("reports gone and never recreates a deleted result on replay", async () => {
    const request = currentNoteRequest();
    const first = await createDirectCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("created");
    if (first.status !== "created") {
      throw new Error("expected created");
    }

    await context.db.transaction((tx) => deleteNoteInTx(tx, first.result.noteId));
    expect(await listNotes()).toHaveLength(0);

    const replay = await createDirectCard(context.deps, DEFAULT_USER_ID, request);
    expect(replay).toEqual({ status: "gone" });
    expect(await listNotes()).toHaveLength(0);
    expect(await listCards()).toHaveLength(0);
    // The receipt tombstone survives the delete cascade.
    expect(await listReceipts()).toHaveLength(1);
  });

  it("reports gone when only the review card was removed, keeping the note", async () => {
    const request = currentNoteRequest();
    const first = await createDirectCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("created");
    if (first.status !== "created") {
      throw new Error("expected created");
    }

    // Remove ONLY the seeded card through the existing unenroll boundary; the note, prompt, contains link,
    // and review history all survive. A later replay must not dereference the now-missing card row.
    await context.db.transaction((tx) => deleteReviewCard(tx, first.result.promptId));
    expect(await listCards()).toHaveLength(0);
    expect(await listNotes()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);

    context.setNow(later);
    const replay = await createDirectCard(context.deps, DEFAULT_USER_ID, request);

    expect(replay).toEqual({ status: "gone" });
    // Nothing is resurrected: no card is re-seeded and the surviving note/prompt/receipt are untouched.
    expect(await listCards()).toHaveLength(0);
    expect(await listNotes()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listReceipts()).toHaveLength(1);
  });

  it("serializes two concurrent identical submissions into exactly one result", async () => {
    const request = currentNoteRequest();
    const [a, b] = await Promise.all([
      createDirectCard(context.deps, DEFAULT_USER_ID, request),
      createDirectCard(context.deps, DEFAULT_USER_ID, request)
    ]);

    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    if (a.status !== "created" || b.status !== "created") {
      throw new Error("expected created");
    }
    expect(a.result.noteId).toBe(b.result.noteId);
    expect(a.result.promptId).toBe(b.result.promptId);

    expect(await listNotes()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
    expect(await listReceipts()).toHaveLength(1);
  });

  it.each([
    ["the note", personalEntries as PgTable],
    ["the prompt", memoryPrompts as PgTable],
    ["the card", reviewCards as PgTable]
  ])("rolls the whole submission back when %s insert fails", async (_label, failTable) => {
    const deps: CreateDirectCardDependencies = {
      ...context.deps,
      db: dbFailingOnInsert(context.db, failTable)
    };

    await expect(createDirectCard(deps, DEFAULT_USER_ID, currentNoteRequest())).rejects.toThrow(
      "injected write failure"
    );

    expect(await listReceipts()).toHaveLength(0);
    expect(await listNotes()).toHaveLength(0);
    expect(await listPrompts()).toHaveLength(0);
    expect(await listCards()).toHaveLength(0);
  });
});

describe("POST /api/notes/review/direct-cards", () => {
  const post = (payload: InjectPayload) =>
    context.server.inject({ method: "POST", payload, url: "/api/notes/review/direct-cards" });

  it("creates a card and returns the result for a current-note target", async () => {
    const response = await post(currentNoteRequest());
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      result: { noteId: string; promptId: string; review: { due: string } };
    };
    expect(body.status).toBe("created");
    expect(body.result.review.due).toBe(now.toISOString());

    const cards = await listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.targetEntryId).toBe(body.result.promptId);
  });

  it("creates a card for an expected-response target", async () => {
    const response = await post(expectedResponseRequest());
    expect(response.statusCode).toBe(200);
    const promptRows = await listPrompts();
    expect(promptRows[0]!.revealKind).toBe("expected_response");
  });

  it("rejects a structurally malformed request with 400", async () => {
    const response = await post({ submissionId: "", questionDoc: questionDoc() });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a blank question with 400 invalid_question", async () => {
    const response = await post({
      submissionId: "sub-q",
      questionDoc: blankDoc(),
      answerDoc: answerDoc(),
      target: { kind: "current_note" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_question" });
  });

  it("rejects a blank answer with 400 invalid_answer", async () => {
    const response = await post({
      submissionId: "sub-a",
      questionDoc: questionDoc(),
      answerDoc: blankDoc(),
      target: { kind: "current_note" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answer" });
  });

  it("rejects a blank Success check with 400 invalid_success_check", async () => {
    const response = await post({
      submissionId: "sub-s",
      questionDoc: questionDoc(),
      answerDoc: answerDoc(),
      target: { kind: "expected_response", successCheckDoc: blankDoc() }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_success_check" });
  });

  it("returns 409 when a submission id is reused with a changed payload", async () => {
    await post(currentNoteRequest());
    const response = await post(
      currentNoteRequest({ answerDoc: answerDoc("A different answer entirely.") })
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "submission_conflict" });
  });

  it("returns 410 when the original note has been deleted", async () => {
    const created = await post(currentNoteRequest());
    const noteId = (created.json() as { result: { noteId: string } }).result.noteId;
    await context.db.transaction((tx) => deleteNoteInTx(tx, noteId));

    const response = await post(currentNoteRequest());
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: "submission_gone" });
  });
});

// Exercise the shared writer's internal receipt-replay branch directly. The save command's own outer
// `findReceiptReplay` pre-empts this on the create path, so a decision (Keep separate) is the real caller —
// but the primitive is what carries the retry-safety, so we assert its replay classification head-on.
describe("writeDirectCardInTx receipt replay", () => {
  function prepared() {
    const result = prepareDirectCardDraft(currentNoteRequest());
    if (result.status !== "ok") {
      throw new Error("expected a valid prepared draft");
    }
    return result.draft;
  }

  it("replays the original result when the same submission re-runs the writer", async () => {
    const draft = prepared();
    const first = await context.db.transaction((tx) =>
      writeDirectCardInTx(tx, {
        attemptId: null,
        channel: "ui",
        draft,
        noteEntryId: toEntryId("note-replay-a"),
        now,
        promptId: "prompt-replay-a",
        submissionId: "sub-replay",
        userId: DEFAULT_USER_ID
      })
    );
    const second = await context.db.transaction((tx) =>
      writeDirectCardInTx(tx, {
        attemptId: null,
        channel: "ui",
        draft,
        noteEntryId: toEntryId("note-replay-b"),
        now,
        promptId: "prompt-replay-b",
        submissionId: "sub-replay",
        userId: DEFAULT_USER_ID
      })
    );

    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("expected both writes to resolve ok");
    }
    expect(second.value).toEqual(first.value);
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });

  it("reports a conflict when the same submission re-runs with a changed payload", async () => {
    const firstDraft = prepared();
    const changed = prepareDirectCardDraft(
      currentNoteRequest({ answerDoc: answerDoc("A completely different answer.") })
    );
    if (changed.status !== "ok") {
      throw new Error("expected a valid changed draft");
    }

    await context.db.transaction((tx) =>
      writeDirectCardInTx(tx, {
        attemptId: null,
        channel: "ui",
        draft: firstDraft,
        noteEntryId: toEntryId("note-conflict-a"),
        now,
        promptId: "prompt-conflict-a",
        submissionId: "sub-conflict",
        userId: DEFAULT_USER_ID
      })
    );
    const second = await context.db.transaction((tx) =>
      writeDirectCardInTx(tx, {
        attemptId: null,
        channel: "ui",
        draft: changed.draft,
        noteEntryId: toEntryId("note-conflict-b"),
        now,
        promptId: "prompt-conflict-b",
        submissionId: "sub-conflict",
        userId: DEFAULT_USER_ID
      })
    );

    expect(second.status).toBe("conflict");
  });
});

// A genuine mid-write DB error inside Use existing material must roll the decision transaction back and
// propagate unchanged — the rollback sentinel only intercepts the (untestable) not_found race, never a real
// failure.
describe("useExistingMaterial write failure", () => {
  it("rolls back and rethrows a mid-write database error", async () => {
    await createDirectCard(
      context.deps,
      DEFAULT_USER_ID,
      currentNoteRequest({ submissionId: "seed" })
    );
    const parked = await createDirectCard(
      context.deps,
      DEFAULT_USER_ID,
      currentNoteRequest({ submissionId: "sub-reuse" })
    );
    if (parked.status !== "needs_material_review") {
      throw new Error("expected the second save to park a review");
    }
    const review = parked.review;

    const failing = {
      ...context.deps,
      db: dbFailingOnInsert(context.db, memoryPrompts as PgTable)
    };
    await expect(
      useExistingMaterial(failing, DEFAULT_USER_ID, {
        submissionId: "sub-reuse",
        attemptId: review.attemptId,
        revision: review.revision,
        noteEntryId: review.candidates[0]!.noteId,
        questionDoc: questionDoc(),
        answerDoc: answerDoc(),
        target: { kind: "current_note" }
      })
    ).rejects.toThrow("injected write failure");

    // The seed's receipt survives; the failed decision's freshly claimed receipt rolled back with the tx.
    expect(await listReceipts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });
});
