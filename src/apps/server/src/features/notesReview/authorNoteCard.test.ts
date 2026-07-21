import { PGlite } from "@electric-sql/pglite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthorNoteCardRequest } from "@whetstone/contracts";
import { createTextDocument, documentReadableText, documentText } from "@whetstone/document";
import { RECALL_REQUEST_RETENTION } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  cardCreationReceipts,
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
import {
  deleteNoteInTx,
  insertNoteInTx,
  insertNotePromptInTx,
  type NotesDependencies
} from "../notes/noteCommands.js";
import { deleteReviewCard } from "../review/reviewCardCommands.js";
import { authorNoteCard, type AuthorNoteCardDependencies } from "./authorNoteCard.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";

const now = new Date("2026-03-01T08:00:00.000Z");
const later = new Date("2026-03-05T09:30:00.000Z");
const otherUser = "user-other";

type TestContext = Readonly<{
  db: DbClient;
  deps: AuthorNoteCardDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;
let sequence = 0;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-author-card-"));

  let clock = now;
  const createId = (): string => `id-${(sequence += 1)}`;
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(sequence += 1)}`,
    createEntryId: () => `work-${(sequence += 1)}`,
    db,
    now: () => new Date()
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(sequence += 1)}`,
    createSourceId: () => `source-${(sequence += 1)}`,
    db,
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };
  const noteDeps: NotesDependencies = {
    createEntryId: () => `note-${(sequence += 1)}`,
    db,
    now: () => clock
  };
  const notesReview: NotesReviewRouteDependencies = { createId, db, now: () => clock };

  return {
    db,
    deps: { createId, db, now: () => clock },
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

function questionDoc(text = "Which sorting algorithm is stable and O(n log n)?") {
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

// Seed a bare owned note (no prompt) and return its entry id, so the first-card command authors its very
// first card. `bodyDoc` becomes the note the card grades against.
async function seedNote(
  over: Partial<{ userId: string; kind: "note" | "mark"; body: string; when: Date }> = {}
): Promise<string> {
  const noteEntryId = `note-${(sequence += 1)}`;
  const isMark = (over.kind ?? "note") === "mark";
  const body = over.body ?? "Merge sort is stable and runs in O(n log n).";
  await context.db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor: null,
      bodyDoc: isMark ? null : createTextDocument(body),
      bodyText: isMark ? null : body,
      captureSource: "manual",
      kind: over.kind ?? "note",
      noteEntryId,
      now: over.when ?? now,
      userId: over.userId ?? DEFAULT_USER_ID
    })
  );
  return noteEntryId;
}

// Seed a historical `legacy_custom` prompt on a note — an imported cardless sibling that the
// one-authored-prompt-per-note invariant must ignore.
async function seedLegacyPrompt(noteEntryId: string): Promise<string> {
  const promptId = `legacy-${(sequence += 1)}`;
  await context.db.transaction((tx) =>
    insertNotePromptInTx(tx, {
      answerDoc: createTextDocument("A preserved custom answer."),
      answerText: "A preserved custom answer.",
      cueDoc: questionDoc("A legacy question?"),
      cueText: "A legacy question?",
      noteEntryId,
      now,
      promptId,
      revealKind: "legacy_custom"
    })
  );
  return promptId;
}

function authorRequest(
  noteEntryId: string,
  over: Partial<AuthorNoteCardRequest> = {}
): AuthorNoteCardRequest {
  return {
    submissionId: "sub-1",
    noteEntryId,
    questionDoc: questionDoc(),
    target: { kind: "current_note" },
    ...over
  };
}

const listReceipts = (userId = DEFAULT_USER_ID) =>
  context.db.select().from(cardCreationReceipts).where(eq(cardCreationReceipts.userId, userId));
const listPrompts = () => context.db.select().from(memoryPrompts);
const listCards = () => context.db.select().from(reviewCards);
const listEvents = () => context.db.select().from(reviewEvents);
const listContains = () =>
  context.db.select().from(entryLinks).where(eq(entryLinks.type, "contains"));
const noteUpdatedAt = async (entryId: string): Promise<number> => {
  const rows = await context.db
    .select({ updatedAt: personalEntries.updatedAt })
    .from(personalEntries)
    .where(eq(personalEntries.entryId, entryId));
  return rows[0]!.updatedAt.getTime();
};

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Wrap a transaction so an insert into `failTable` throws, exercising a mid-transaction failure at a
// specific write step through the real client boundary.
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

// Wrap the database so the note is deleted (committed) the instant the author command opens its
// transaction — after its up-front authorize saw the note, but before its `FOR UPDATE` lock. This is the
// only faithful way to exercise the between-authorize-and-lock deletion race with a single connection.
function dbDeletingNoteBeforeTransaction(db: DbClient, noteEntryId: string): DbClient {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async <T>(callback: (tx: Tx) => Promise<T>): Promise<T> => {
          await target.transaction((tx) => deleteNoteInTx(tx, noteEntryId));
          return target.transaction(callback);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

describe("authorNoteCard", () => {
  it("authors a current-note prompt, contains link, and active card due now with no note write or event", async () => {
    const noteEntryId = await seedNote();
    const beforeUpdatedAt = await noteUpdatedAt(noteEntryId);

    const result = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(noteEntryId));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.value.noteId).toBe(noteEntryId);
    expect(result.value.review.due).toBe(now.toISOString());

    const promptRows = await listPrompts();
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({
      answerDoc: null,
      answerText: null,
      cueText: documentReadableText(questionDoc()),
      entryId: result.value.promptId,
      lifecycle: "ready",
      noteEntryId,
      revealKind: "current_note"
    });

    expect(await listContains()).toEqual([
      expect.objectContaining({ fromEntryId: noteEntryId, toEntryId: result.value.promptId })
    ]);

    const cards = await listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      requestedRetention: RECALL_REQUEST_RETENTION,
      status: "active",
      targetEntryId: result.value.promptId,
      userId: DEFAULT_USER_ID
    });
    expect(cards[0]!.dueAt.getTime()).toBe(now.getTime());

    // No review event and — the note write stays in the Note tab — no touch to the note's updated_at.
    expect(await listEvents()).toHaveLength(0);
    expect(await noteUpdatedAt(noteEntryId)).toBe(beforeUpdatedAt);

    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      noteEntryId,
      promptEntryId: result.value.promptId,
      submissionId: "sub-1",
      userId: DEFAULT_USER_ID
    });
    expect(receipts[0]!.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("authors an expected-response prompt carrying the server-derived Success check", async () => {
    const noteEntryId = await seedNote();
    const check = successCheckDoc("The answer names merge sort and calls it stable.");

    const result = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest(noteEntryId, {
        target: { kind: "expected_response", successCheckDoc: check }
      })
    );
    expect(result.status).toBe("ok");

    const promptRows = await listPrompts();
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({
      answerDoc: check,
      answerText: documentText(check),
      revealKind: "expected_response"
    });
  });

  it("authors over a note that owns only a historical legacy_custom sibling", async () => {
    const noteEntryId = await seedNote();
    await seedLegacyPrompt(noteEntryId);

    const result = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(noteEntryId));

    expect(result.status).toBe("ok");
    // The legacy sibling is untouched and the new authored prompt joins it.
    const kinds = (await listPrompts()).map((row) => row.revealKind).sort();
    expect(kinds).toEqual(["current_note", "legacy_custom"]);
  });

  it("rejects a blank question before any write", async () => {
    const noteEntryId = await seedNote();
    const result = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest(noteEntryId, {
        questionDoc: blankDoc() as AuthorNoteCardRequest["questionDoc"]
      })
    );
    expect(result).toEqual({ status: "invalid_question" });
    expect(await listPrompts()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("rejects a blank Success check before any write", async () => {
    const noteEntryId = await seedNote();
    const result = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest(noteEntryId, {
        target: {
          kind: "expected_response",
          successCheckDoc: blankDoc() as AuthorNoteCardRequest["questionDoc"]
        }
      })
    );
    expect(result).toEqual({ status: "invalid_success_check" });
    expect(await listPrompts()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("reports not_found for a forged or cross-user note", async () => {
    const missing = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest("note-does-not-exist")
    );
    expect(missing).toEqual({ status: "not_found" });

    const theirs = await seedNote({ userId: otherUser });
    const crossUser = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(theirs));
    expect(crossUser).toEqual({ status: "not_found" });
    expect(await listReceipts()).toHaveLength(0);
  });

  it("reports not_found for a bodyless Mark that cannot hold a recall card", async () => {
    const markEntryId = await seedNote({ kind: "mark" });
    const result = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(markEntryId));
    expect(result).toEqual({ status: "not_found" });
    expect(await listPrompts()).toHaveLength(0);
  });

  it("reports already_authored for a distinct second submission and rolls its receipt back", async () => {
    const noteEntryId = await seedNote();
    const first = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(noteEntryId));
    expect(first.status).toBe("ok");

    const second = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest(noteEntryId, { submissionId: "sub-2", questionDoc: questionDoc("Another cue?") })
    );
    expect(second).toEqual({ status: "already_authored" });
    // Exactly one authored prompt and one card survive; the loser's receipt rolled back so a later retry
    // re-decides cleanly.
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
    expect(await listReceipts()).toHaveLength(1);
  });

  it("returns the original result on an identical retry without writing a second card", async () => {
    const noteEntryId = await seedNote();
    const request = authorRequest(noteEntryId);
    const first = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("ok");

    context.setNow(later);
    const retry = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);

    expect(retry).toEqual(first);
    expect(await listReceipts()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
    if (retry.status !== "ok") {
      throw new Error("expected ok");
    }
    // The replayed result still carries the ORIGINAL due instant, not the advanced clock.
    expect(retry.value.review.due).toBe(now.toISOString());
  });

  it("reports a conflict when the same submission id carries a changed payload", async () => {
    const noteEntryId = await seedNote();
    const first = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(noteEntryId));
    expect(first.status).toBe("ok");

    const conflict = await authorNoteCard(
      context.deps,
      DEFAULT_USER_ID,
      authorRequest(noteEntryId, { questionDoc: questionDoc("A different cue entirely?") })
    );
    expect(conflict).toEqual({ status: "conflict" });
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });

  it("reports not_found on replay once the note has been deleted", async () => {
    const noteEntryId = await seedNote();
    const request = authorRequest(noteEntryId);
    const first = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("ok");

    await context.db.transaction((tx) => deleteNoteInTx(tx, noteEntryId));
    expect(await listPrompts()).toHaveLength(0);

    // The up-front owner authorize sees the missing note first, so a deleted note resolves as not_found
    // before the replay path is ever reached; the receipt tombstone still survives the cascade.
    const replay = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);
    expect(replay).toEqual({ status: "not_found" });
    expect(await listPrompts()).toHaveLength(0);
    expect(await listCards()).toHaveLength(0);
    expect(await listReceipts()).toHaveLength(1);
  });

  it("reports gone when only the seeded card was removed, keeping the note and prompt", async () => {
    const noteEntryId = await seedNote();
    const request = authorRequest(noteEntryId);
    const first = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") {
      throw new Error("expected ok");
    }

    // Remove ONLY the seeded card; the note, prompt, contains link, and receipt survive. A replay must read
    // gone rather than dereference the now-missing card row.
    await context.db.transaction((tx) => deleteReviewCard(tx, first.value.promptId));
    expect(await listCards()).toHaveLength(0);
    expect(await listPrompts()).toHaveLength(1);

    context.setNow(later);
    const replay = await authorNoteCard(context.deps, DEFAULT_USER_ID, request);
    expect(replay).toEqual({ status: "gone" });
    // Nothing is resurrected; the surviving note/prompt/receipt are untouched.
    expect(await listCards()).toHaveLength(0);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listReceipts()).toHaveLength(1);
  });

  it("isolates owners so the same submission id and note-shaped request stay independent", async () => {
    const mineNote = await seedNote();
    const theirNote = await seedNote({ userId: otherUser });

    const mine = await authorNoteCard(context.deps, DEFAULT_USER_ID, authorRequest(mineNote));
    const theirs = await authorNoteCard(context.deps, otherUser, authorRequest(theirNote));

    expect(mine.status).toBe("ok");
    expect(theirs.status).toBe("ok");
    expect(await listReceipts(DEFAULT_USER_ID)).toHaveLength(1);
    expect(await listReceipts(otherUser)).toHaveLength(1);
    expect(await listCards()).toHaveLength(2);
  });

  it("serializes two concurrent identical submissions into exactly one card", async () => {
    const noteEntryId = await seedNote();
    const request = authorRequest(noteEntryId);
    const [a, b] = await Promise.all([
      authorNoteCard(context.deps, DEFAULT_USER_ID, request),
      authorNoteCard(context.deps, DEFAULT_USER_ID, request)
    ]);

    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    if (a.status !== "ok" || b.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(a.value.promptId).toBe(b.value.promptId);
    expect(await listPrompts()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
    expect(await listReceipts()).toHaveLength(1);
  });

  it("rolls the whole submission back when the note is deleted between authorize and lock", async () => {
    const noteEntryId = await seedNote();
    const deps: AuthorNoteCardDependencies = {
      ...context.deps,
      db: dbDeletingNoteBeforeTransaction(context.db, noteEntryId)
    };

    const result = await authorNoteCard(deps, DEFAULT_USER_ID, authorRequest(noteEntryId));

    expect(result).toEqual({ status: "not_found" });
    // The freshly claimed receipt is discarded with the rolled-back transaction.
    expect(await listReceipts()).toHaveLength(0);
    expect(await listPrompts()).toHaveLength(0);
    expect(await listCards()).toHaveLength(0);
  });

  it.each([
    ["the prompt", memoryPrompts as PgTable],
    ["the card", reviewCards as PgTable]
  ])("rolls the whole submission back when %s insert fails", async (_label, failTable) => {
    const noteEntryId = await seedNote();
    const deps: AuthorNoteCardDependencies = {
      ...context.deps,
      db: dbFailingOnInsert(context.db, failTable)
    };

    await expect(
      authorNoteCard(deps, DEFAULT_USER_ID, authorRequest(noteEntryId))
    ).rejects.toThrow("injected write failure");

    expect(await listReceipts()).toHaveLength(0);
    expect(await listPrompts()).toHaveLength(0);
    expect(await listCards()).toHaveLength(0);
  });
});

describe("POST /api/notes/review/author-cards", () => {
  const post = (payload: unknown) =>
    context.server.inject({ method: "POST", payload, url: "/api/notes/review/author-cards" });

  it("authors a card and returns the result for a current-note target", async () => {
    const noteEntryId = await seedNote();
    const response = await post(authorRequest(noteEntryId));
    expect(response.statusCode).toBe(200);
    const body = response.json() as { noteId: string; promptId: string; review: { due: string } };
    expect(body.noteId).toBe(noteEntryId);
    expect(body.review.due).toBe(now.toISOString());
    expect((await listCards())[0]!.targetEntryId).toBe(body.promptId);
  });

  it("authors a card for an expected-response target", async () => {
    const noteEntryId = await seedNote();
    const response = await post(
      authorRequest(noteEntryId, {
        target: { kind: "expected_response", successCheckDoc: successCheckDoc() }
      })
    );
    expect(response.statusCode).toBe(200);
    expect((await listPrompts())[0]!.revealKind).toBe("expected_response");
  });

  it("rejects a structurally malformed request with 400", async () => {
    const response = await post({ submissionId: "", noteEntryId: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a blank question with 400 invalid_question", async () => {
    const noteEntryId = await seedNote();
    const response = await post(authorRequest(noteEntryId, { questionDoc: blankDoc() as never }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_question" });
  });

  it("rejects a blank Success check with 400 invalid_success_check", async () => {
    const noteEntryId = await seedNote();
    const response = await post(
      authorRequest(noteEntryId, {
        target: { kind: "expected_response", successCheckDoc: blankDoc() as never }
      })
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_success_check" });
  });

  it("returns 404 for a note that is not the caller's", async () => {
    const response = await post(authorRequest("note-missing"));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("returns 409 already_authored for a distinct second submission", async () => {
    const noteEntryId = await seedNote();
    await post(authorRequest(noteEntryId));
    const response = await post(
      authorRequest(noteEntryId, { submissionId: "sub-2", questionDoc: questionDoc("Another cue?") })
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "already_authored" });
  });

  it("returns 409 submission_conflict when a submission id is reused with a changed payload", async () => {
    const noteEntryId = await seedNote();
    await post(authorRequest(noteEntryId));
    const response = await post(
      authorRequest(noteEntryId, { questionDoc: questionDoc("A different cue entirely?") })
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "submission_conflict" });
  });

  it("returns 410 when the note's seeded card has since been removed", async () => {
    const noteEntryId = await seedNote();
    const created = await post(authorRequest(noteEntryId));
    const promptId = (created.json() as { promptId: string }).promptId;
    await context.db.transaction((tx) => deleteReviewCard(tx, promptId));
    const response = await post(authorRequest(noteEntryId));
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: "submission_gone" });
  });
});
