import { PGlite } from "@electric-sql/pglite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateDirectCardRequest,
  KeepSeparateMaterialRequest,
  UseExistingMaterialRequest
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { memoryPrompts, notes, reviewCards } from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import { deleteNoteInTx } from "../notes/noteCommands.js";
import type { NotesDependencies } from "../notes/noteCommands.js";
import { queryExactMaterial } from "./exactMaterialQuery.js";
import type { NotesReviewRouteDependencies } from "./notesReviewRoutes.js";

const now = new Date("2026-03-01T08:00:00.000Z");
const later = new Date("2026-03-05T09:30:00.000Z");
const answerText = "Merge sort is stable and runs in O(n log n).";

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
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-material-review-"));

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
  const notesReview: NotesReviewRouteDependencies = {
    attemptTtlMs: 30 * 60 * 1000,
    createId,
    db,
    now: () => clock
  };

  return {
    db,
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
function answerDoc(text = answerText) {
  return createTextDocument(text);
}
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

const saveDirect = (payload: unknown) =>
  context.server.inject({ method: "POST", payload, url: "/api/notes/review/direct-cards" });
const materialMatches = (payload: unknown) =>
  context.server.inject({ method: "POST", payload, url: "/api/notes/review/material-matches" });
const useExisting = (payload: unknown) =>
  context.server.inject({
    method: "POST",
    payload,
    url: "/api/notes/review/material-review/use-existing"
  });
const keepSeparate = (payload: unknown) =>
  context.server.inject({
    method: "POST",
    payload,
    url: "/api/notes/review/material-review/keep-separate"
  });

const listNotes = () => context.db.select().from(notes);
const listPrompts = () => context.db.select().from(memoryPrompts);
const listCards = () => context.db.select().from(reviewCards);
const deleteNote = (noteEntryId: string) =>
  context.db.transaction((tx) => deleteNoteInTx(tx, noteEntryId));

type ReviewBody = Readonly<{
  status: "needs_material_review";
  review: {
    attemptId: string;
    candidateFingerprint: string;
    candidates: ReadonlyArray<{ answerExcerpt: string; cardCount: number; noteId: string }>;
    revision: number;
  };
}>;
type CreatedBody = Readonly<{ status: "created" | "reused"; result: { noteId: string } }>;

// Save one direct card and assert it created a fresh note, returning the created note id.
async function seedMaterial(submissionId: string): Promise<string> {
  const response = await saveDirect(currentNoteRequest({ submissionId }));
  expect(response.statusCode).toBe(200);
  return (response.json() as CreatedBody).result.noteId;
}

// Park a review over the shared answer under `submissionId`, asserting the save returned a review.
async function parkReview(submissionId: string): Promise<ReviewBody["review"]> {
  const response = await saveDirect(currentNoteRequest({ submissionId }));
  expect(response.statusCode).toBe(200);
  const body = response.json() as ReviewBody;
  expect(body.status).toBe("needs_material_review");
  return body.review;
}

// Mint a second distinct note over the shared answer through a Keep-separate decision, so the recheck can
// later see more than one candidate.
async function keepSeparateNewNote(submissionId: string): Promise<string> {
  const review = await parkReview(submissionId);
  const response = await keepSeparate({
    submissionId,
    attemptId: review.attemptId,
    revision: review.revision,
    questionDoc: questionDoc(),
    answerDoc: answerDoc(),
    target: { kind: "current_note" }
  } satisfies KeepSeparateMaterialRequest);
  expect(response.statusCode).toBe(200);
  return (response.json() as CreatedBody).result.noteId;
}

describe("New-card save material-review gate", () => {
  it("parks a review with the existing candidate instead of creating a duplicate", async () => {
    const noteId = await seedMaterial("seed");
    const review = await parkReview("sub-review");

    expect(review.candidates).toEqual([
      { answerExcerpt: answerText, cardCount: 1, noteId, sourceContext: null }
    ]);
    expect(review.revision).toBe(0);
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });

  it("resumes the same review on an unchanged retry without bumping the revision", async () => {
    await seedMaterial("seed");
    const first = await parkReview("sub-review");
    const second = await parkReview("sub-review");

    expect(second.attemptId).toBe(first.attemptId);
    expect(second.revision).toBe(0);
    expect(await listNotes()).toHaveLength(1);
  });

  it("refreshes the review when the candidate set changed since the earlier save", async () => {
    await seedMaterial("seed");
    const second = await keepSeparateNewNote("sub-second");
    const review = await parkReview("sub-review");
    expect(review.candidates).toHaveLength(2);

    await deleteNote(second);
    const refreshed = await parkReview("sub-review");

    expect(refreshed.attemptId).toBe(review.attemptId);
    expect(refreshed.revision).toBe(1);
    expect(refreshed.candidates).toHaveLength(1);
  });

  it("discards a stale parked review and creates directly when its material vanished", async () => {
    const noteId = await seedMaterial("seed");
    await parkReview("sub-review");

    await deleteNote(noteId);
    const response = await saveDirect(currentNoteRequest({ submissionId: "sub-review" }));

    expect(response.statusCode).toBe(200);
    expect((response.json() as CreatedBody).status).toBe("created");
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
  });
});

describe("POST /api/notes/review/material-matches", () => {
  it("returns the exact-material candidates for a drafted answer", async () => {
    const noteId = await seedMaterial("seed");
    const response = await materialMatches({ answerDoc: answerDoc() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      candidates: [{ answerExcerpt: answerText, cardCount: 1, noteId, sourceContext: null }]
    });
  });

  it("returns an empty candidate list for an answer with no existing material", async () => {
    const response = await materialMatches({ answerDoc: answerDoc("A brand new fact.") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [] });
  });

  it("resolves a blank answer to an empty list rather than an error", async () => {
    const response = await materialMatches({ answerDoc: blankDoc() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [] });
  });

  it("rejects a structurally malformed request with 400", async () => {
    const response = await materialMatches({});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("POST /api/notes/review/material-review/use-existing", () => {
  const decide = (review: ReviewBody["review"], over: Partial<UseExistingMaterialRequest> = {}) =>
    useExisting({
      submissionId: "sub-review",
      attemptId: review.attemptId,
      revision: review.revision,
      noteEntryId: over.noteEntryId ?? review.candidates[0]!.noteId,
      questionDoc: questionDoc(),
      answerDoc: answerDoc(),
      target: { kind: "current_note" },
      ...over
    });

  it("adds a second card to the chosen note instead of minting a new one", async () => {
    const noteId = await seedMaterial("seed");
    const review = await parkReview("sub-review");

    const response = await decide(review);
    expect(response.statusCode).toBe(200);
    const body = response.json() as CreatedBody;
    expect(body.status).toBe("reused");
    expect(body.result.noteId).toBe(noteId);

    expect(await listNotes()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(2);
    expect(await listCards()).toHaveLength(2);
  });

  it("rejects a replayed decision as superseded once the attempt is consumed", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    expect((await decide(review)).statusCode).toBe(200);

    const replay = await decide(review);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: "attempt_superseded" });
  });

  it("re-parks the review when the chosen note is no longer a candidate", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");

    const response = await decide(review, { noteEntryId: "note-not-a-candidate" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ReviewBody;
    expect(body.status).toBe("needs_material_review");
    expect(body.review.revision).toBe(1);
    expect(await listCards()).toHaveLength(1);
  });

  it("rejects a blank answer with 400 invalid_answer before touching the attempt", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    const response = await decide(review, {
      answerDoc: blankDoc() as UseExistingMaterialRequest["answerDoc"]
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answer" });
  });

  it("rejects a structurally malformed request with 400", async () => {
    const response = await useExisting({ submissionId: "sub-review" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("returns 404 for an unknown attempt", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    const response = await decide(review, { attemptId: "missing-attempt" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "attempt_not_found" });
  });

  it("returns 409 for a stale revision", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    const response = await decide(review, { revision: review.revision + 5 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "attempt_superseded" });
  });

  it("returns 409 when the resubmitted answer changed", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    const response = await decide(review, { answerDoc: answerDoc("An edited answer entirely.") });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "changed_payload" });
  });

  it("returns 410 once the attempt has expired", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    context.setNow(later);
    const response = await decide(review);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: "attempt_expired" });
  });
});

describe("POST /api/notes/review/material-review/keep-separate", () => {
  const decide = (review: ReviewBody["review"], over: Partial<KeepSeparateMaterialRequest> = {}) =>
    keepSeparate({
      submissionId: "sub-review",
      attemptId: review.attemptId,
      revision: review.revision,
      questionDoc: questionDoc(),
      answerDoc: answerDoc(),
      target: { kind: "current_note" },
      ...over
    });

  it("mints a distinct note despite the existing material", async () => {
    const seeded = await seedMaterial("seed");
    const review = await parkReview("sub-review");

    const response = await decide(review);
    expect(response.statusCode).toBe(200);
    const body = response.json() as CreatedBody;
    expect(body.status).toBe("created");
    expect(body.result.noteId).not.toBe(seeded);

    expect(await listNotes()).toHaveLength(2);
    expect(await listCards()).toHaveLength(2);
  });

  it("re-parks the review when the candidate set changed since the decision", async () => {
    await seedMaterial("seed");
    const second = await keepSeparateNewNote("sub-second");
    const review = await parkReview("sub-review");
    expect(review.candidates).toHaveLength(2);

    await deleteNote(second);
    const response = await decide(review);
    expect(response.statusCode).toBe(200);
    const body = response.json() as ReviewBody;
    expect(body.status).toBe("needs_material_review");
    expect(body.review.revision).toBe(1);
    expect(body.review.candidates).toHaveLength(1);
  });

  it("creates directly when the reviewed material has entirely vanished", async () => {
    const seeded = await seedMaterial("seed");
    const review = await parkReview("sub-review");

    await deleteNote(seeded);
    const response = await decide(review);
    expect(response.statusCode).toBe(200);
    expect((response.json() as CreatedBody).status).toBe("created");
    expect(await listNotes()).toHaveLength(1);
  });

  it("rejects a structurally malformed request with 400", async () => {
    const response = await keepSeparate({ submissionId: "sub-review" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("returns 404 for an unknown attempt", async () => {
    await seedMaterial("seed");
    await parkReview("sub-review");
    const response = await decide(
      { attemptId: "missing", candidateFingerprint: "x", candidates: [], revision: 0 },
      {}
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "attempt_not_found" });
  });

  it("rejects a blank answer with 400 invalid_answer", async () => {
    await seedMaterial("seed");
    const review = await parkReview("sub-review");
    const response = await decide(review, {
      answerDoc: blankDoc() as KeepSeparateMaterialRequest["answerDoc"]
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_answer" });
  });
});

describe("queryExactMaterial", () => {
  it("re-throws a non-blank projection error rather than swallowing it", async () => {
    await expect(queryExactMaterial(context.db, DEFAULT_USER_ID, 42)).rejects.toThrow();
  });
});
