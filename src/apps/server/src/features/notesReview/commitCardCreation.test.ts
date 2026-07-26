import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpCommitCardResult, NoteGradingTarget } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  cardCreationReceipts,
  memoryPrompts,
  notes,
  personalEntries,
  reviewCards
} from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { LexicalRelationService } from "../lexical/lexicalRelationService.js";
import {
  getCardCreationAttempt,
  insertPendingCardCreationAttempt
} from "./cardCreationAttemptStore.js";
import {
  commitCardCreation,
  type CommitCardCreationDependencies,
  type CommitCardCreationRequest
} from "./commitCardCreation.js";
import { createDirectCard, type CreateDirectCardDependencies } from "./createDirectCard.js";
import {
  previewCardCreation,
  type PreviewCardCreationDependencies,
  type PreviewCardCreationRequest
} from "./previewCardCreation.js";

const now = new Date("2026-03-01T08:00:00.000Z");
const otherUser = "user-other";
const ttlMs = 30 * 60 * 1000;
const answerA = "Merge sort is stable and O(n log n).";

let db: DbClient;
let clock: Date;
let sequence: number;

// The commit reaches lexical through no boundary of its own (only preview does), so a fake that never resolves
// is sufficient for staging attempts through the real preview command.
const fakeLexical: LexicalRelationService = {
  resolveSenses: async () => ({ kind: "not_found" }),
  relateNotes: async () => ({ kind: "not_found" })
};

function previewDeps(): PreviewCardCreationDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `attempt-${(sequence += 1)}`,
    db,
    lexical: fakeLexical,
    now: () => clock
  };
}

function commitDeps(): CommitCardCreationDependencies {
  return {
    createId: () => `card-${(sequence += 1)}`,
    db,
    now: () => clock
  };
}

// Seed real saved material through the canonical save so exact/near matching has candidates. Its own id space
// keeps a seeded note id distinct from a staged attempt id. Seeds a current-note prompt.
function directCardDeps(): CreateDirectCardDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `seed-${(sequence += 1)}`,
    db,
    now: () => clock
  };
}

async function seedMaterial(answer: string, submissionId: string): Promise<string> {
  const result = await createDirectCard(directCardDeps(), DEFAULT_USER_ID, {
    submissionId,
    questionDoc: createTextDocument("Seed question?"),
    answerDoc: createTextDocument(answer),
    target: { kind: "current_note" }
  });
  if (result.status !== "created") {
    throw new Error(`expected seeded card, got ${result.status}`);
  }
  return result.result.noteId;
}

const expectedResponseTarget = (text: string): NoteGradingTarget => ({
  kind: "expected_response",
  successCheckDoc: createTextDocument(text)
});

function previewRequest(
  over: Partial<PreviewCardCreationRequest> = {}
): PreviewCardCreationRequest {
  return {
    submissionId: "req-1",
    questionDoc: createTextDocument("Which sorting algorithm is stable?"),
    answerDoc: createTextDocument(answerA),
    target: { kind: "current_note" },
    sense: null,
    ...over
  };
}

// Stage one mcp attempt through the real preview command and return its opaque id.
async function stage(over: Partial<PreviewCardCreationRequest> = {}): Promise<string> {
  const result = await previewCardCreation(previewDeps(), DEFAULT_USER_ID, previewRequest(over));
  if (result.status !== "previewed") {
    throw new Error(`expected previewed, got ${result.status}`);
  }
  return result.attemptId;
}

function commit(
  attemptId: string,
  decision: CommitCardCreationRequest["decision"],
  userId = DEFAULT_USER_ID
): Promise<McpCommitCardResult> {
  return commitCardCreation(commitDeps(), userId, { attemptId, decision });
}

const listNotes = () => db.select().from(notes);
const listCards = () => db.select().from(reviewCards);
const listReceipts = () => db.select().from(cardCreationReceipts);
const listPrompts = () => db.select().from(memoryPrompts);

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  clock = now;
  sequence = 0;
});

afterEach(async () => {
  // PGlite instances are per-test and garbage-collected; nothing to close explicitly.
});

describe("commitCardCreation", () => {
  it("creates a standalone card for a no-candidate approved draft and stamps the mcp channel", async () => {
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "create" });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.card.noteId).toBeTruthy();
    expect(result.card.promptId).toBeTruthy();
    // Exactly one note+prompt+card, all owner-scoped.
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(1);
    expect(await listPrompts()).toHaveLength(1);

    // The receipt records the immutable mcp audit channel and the consumed attempt id.
    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ channel: "mcp", attemptId });

    // The attempt is consumed with the recorded decision.
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "consumed", decision: "create" });
  });

  it("creates a graded card carrying the staged success check", async () => {
    const attemptId = await stage({
      target: expectedResponseTarget("Names merge sort and stability.")
    });
    const result = await commit(attemptId, { kind: "create" });

    expect(result.status).toBe("created");
    const prompts = await listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      revealKind: "expected_response",
      answerText: "Names merge sort and stability."
    });
  });

  it("keeps a separate card despite candidates, minting a distinct note", async () => {
    const seededId = await seedMaterial(answerA, "seed-keep");
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "keep_separate" });

    expect(result.status).toBe("kept_separate");
    if (result.status !== "kept_separate") throw new Error("expected kept_separate");
    // A brand-new note distinct from the reviewed candidate, so two notes now exist.
    expect(result.card.noteId).not.toBe(seededId);
    expect(await listNotes()).toHaveLength(2);

    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "consumed", decision: "keep_separate" });
  });

  it("reuses an exact candidate note without creating a new note or disturbing its schedule", async () => {
    const seededId = await seedMaterial(answerA, "seed-reuse");
    const cardsBefore = await listCards();
    expect(cardsBefore).toHaveLength(1);

    const attemptId = await stage({
      target: expectedResponseTarget("Recalls merge sort stability.")
    });
    const result = await commit(attemptId, { kind: "reuse", noteEntryId: seededId });

    expect(result.status).toBe("reused");
    if (result.status !== "reused") throw new Error("expected reused");
    expect(result.card.noteId).toBe(seededId);
    // No new note; the direction was added to the reviewed note (now two cards, two prompts).
    expect(await listNotes()).toHaveLength(1);
    expect(await listCards()).toHaveLength(2);

    // The sibling card that already existed on the reused note is untouched — same schedule.
    const preexisting = cardsBefore[0]!;
    const after = (await listCards()).find(
      (card) => card.targetEntryId === preexisting.targetEntryId
    );
    expect(after).toEqual(preexisting);

    const receipts = await listReceipts();
    expect(receipts).toHaveLength(2);
    expect(
      receipts.some((receipt) => receipt.channel === "mcp" && receipt.attemptId === attemptId)
    ).toBe(true);
  });

  it("reuses a near-match candidate note", async () => {
    const seededId = await seedMaterial("in term of the design", "seed-near");
    const attemptId = await stage({
      answerDoc: createTextDocument("in terms of the design"),
      target: expectedResponseTarget("Names the design phrase.")
    });
    const result = await commit(attemptId, { kind: "reuse", noteEntryId: seededId });

    expect(result.status).toBe("reused");
    if (result.status !== "reused") throw new Error("expected reused");
    expect(result.card.noteId).toBe(seededId);
    expect(await listNotes()).toHaveLength(1);
  });

  it("rejects a create when reviewed candidates exist, writing nothing", async () => {
    await seedMaterial(answerA, "seed-exists");
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "create" });

    expect(result).toEqual({ status: "candidates_exist" });
    // Only the seeded note exists; the attempt stays pending for the learner to re-decide.
    expect(await listNotes()).toHaveLength(1);
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "pending" });
  });

  it("rejects a keep_separate when there is no reviewed material", async () => {
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "keep_separate" });

    expect(result).toEqual({ status: "no_material" });
    expect(await listNotes()).toHaveLength(0);
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "pending" });
  });

  it("rejects a reuse of a note that is not among the reviewed candidates", async () => {
    await seedMaterial(answerA, "seed-cand");
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "reuse", noteEntryId: "note-not-a-candidate" });

    expect(result).toEqual({ status: "not_a_candidate" });
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "pending" });
  });

  it("re-parks the preview for fresh approval when a candidate appears after approval", async () => {
    // Approve a draft with no candidates, then material matching it is saved before the commit.
    const attemptId = await stage();
    await seedMaterial(answerA, "seed-late");

    const result = await commit(attemptId, { kind: "create" });
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") throw new Error("expected needs_approval");
    expect(result.preview.attemptId).toBe(attemptId);
    expect(result.preview.approvalRequired).toBe(true);
    expect(result.preview.nextAction).toBe("present_preview_and_request_approval");
    expect(result.preview.renderedCard.successCheck).toBeNull();
    expect(result.preview.candidates).toHaveLength(1);
    expect(result.preview.revision).toBe(1);

    // Nothing was written and the attempt is refreshed but still pending.
    expect(await listCards()).toHaveLength(1);
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "pending", revision: 1 });
  });

  it("renders the graded success check in a refreshed preview", async () => {
    const attemptId = await stage({
      target: expectedResponseTarget("Names merge sort and stability.")
    });
    await seedMaterial(answerA, "seed-late-graded");

    const result = await commit(attemptId, { kind: "create" });
    if (result.status !== "needs_approval") throw new Error("expected needs_approval");
    expect(result.preview.renderedCard.successCheck).toBe("Names merge sort and stability.");
  });

  it("reports expired for a lapsed approval window and writes nothing", async () => {
    const attemptId = await stage();
    clock = new Date(now.getTime() + ttlMs + 1);
    const result = await commit(attemptId, { kind: "create" });

    expect(result).toEqual({ status: "expired" });
    expect(await listCards()).toHaveLength(0);
    // The lapsed attempt is swept after the commit resolves.
    expect(await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId)).toBeNull();
  });

  it("reports not_found for a forged attempt id", async () => {
    const result = await commit("attempt-does-not-exist", { kind: "create" });
    expect(result).toEqual({ status: "not_found" });
  });

  it("reports not_found for another owner's attempt", async () => {
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "create" }, otherUser);
    expect(result).toEqual({ status: "not_found" });
    // The real owner's attempt is untouched.
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, attemptId);
    expect(attempt).toMatchObject({ state: "pending" });
  });

  it("reports not_found for a ui review attempt (no staged draft)", async () => {
    // A ui New-card save that hits existing material stages a ui attempt with a null draft payload.
    await seedMaterial(answerA, "seed-ui");
    const save = await createDirectCard(directCardDeps(), DEFAULT_USER_ID, {
      submissionId: "ui-save",
      questionDoc: createTextDocument("Which sorting algorithm is stable?"),
      answerDoc: createTextDocument(answerA),
      target: { kind: "current_note" }
    });
    if (save.status !== "needs_material_review") throw new Error("expected needs_material_review");
    const result = await commit(save.review.attemptId, { kind: "create" });
    expect(result).toEqual({ status: "not_found" });
  });

  it("reports not_found for a malformed mcp attempt missing its staged draft", async () => {
    // A defensive guard: an mcp attempt row without a staged draft can never be committed (the draft is the
    // only content source). Inserted directly since the preview command never produces this shape.
    await insertPendingCardCreationAttempt(db, {
      draftFingerprint: "fp",
      draftPayload: null,
      exactNoteIds: [],
      expiresAt: new Date(now.getTime() + ttlMs),
      id: "mcp-no-draft",
      nearKeys: [],
      nearNoteIds: [],
      now,
      source: "mcp",
      submissionId: "req-malformed",
      userId: DEFAULT_USER_ID
    });
    const result = await commit("mcp-no-draft", { kind: "create" });
    expect(result).toEqual({ status: "not_found" });
  });

  it("replays the same result for an identical retry after a create (idempotent)", async () => {
    const attemptId = await stage();
    const first = await commit(attemptId, { kind: "create" });
    if (first.status !== "created") throw new Error("expected created");
    const second = await commit(attemptId, { kind: "create" });

    expect(second).toEqual(first);
    // Still exactly one card — the retry did not double-enroll.
    expect(await listCards()).toHaveLength(1);
  });

  it("replays the same result for an identical keep_separate retry", async () => {
    await seedMaterial(answerA, "seed-keep-retry");
    const attemptId = await stage();
    const first = await commit(attemptId, { kind: "keep_separate" });
    if (first.status !== "kept_separate") throw new Error("expected kept_separate");
    const second = await commit(attemptId, { kind: "keep_separate" });
    expect(second).toEqual(first);
    // The seeded note plus exactly one kept-separate note.
    expect(await listNotes()).toHaveLength(2);
  });

  it("replays the same result for an identical reuse retry", async () => {
    const seededId = await seedMaterial(answerA, "seed-reuse-retry");
    const attemptId = await stage({ target: expectedResponseTarget("Recalls stability.") });
    const first = await commit(attemptId, { kind: "reuse", noteEntryId: seededId });
    if (first.status !== "reused") throw new Error("expected reused");
    const second = await commit(attemptId, { kind: "reuse", noteEntryId: seededId });
    expect(second).toEqual(first);
    expect(await listCards()).toHaveLength(2);
  });

  it("rejects a retry with a different decision as a conflict", async () => {
    const attemptId = await stage();
    const first = await commit(attemptId, { kind: "create" });
    expect(first.status).toBe("created");
    // A retry of the consumed attempt with a different decision kind cannot re-decide the settled card.
    const second = await commit(attemptId, { kind: "keep_separate" });
    expect(second).toEqual({ status: "decision_conflict" });
    expect(await listCards()).toHaveLength(1);
  });

  it("rejects a retry that reuses a different note as a conflict", async () => {
    const seededId = await seedMaterial(answerA, "seed-reuse-diff");
    const attemptId = await stage({ target: expectedResponseTarget("Recalls stability.") });
    const first = await commit(attemptId, { kind: "reuse", noteEntryId: seededId });
    expect(first.status).toBe("reused");
    // The recorded decision fixed the reused note; reusing a different note on retry is a decision conflict.
    const second = await commit(attemptId, { kind: "reuse", noteEntryId: "some-other-note" });
    expect(second).toEqual({ status: "decision_conflict" });
    expect(await listCards()).toHaveLength(2);
  });

  it("reports conflict when the request id was already committed for a different draft", async () => {
    // Commit request req-1 with draft A, consuming its attempt and claiming its receipt.
    const firstAttempt = await stage();
    expect((await commit(firstAttempt, { kind: "create" })).status).toBe("created");

    // The same request id now stages a fresh attempt with a DIFFERENT draft (the prior attempt is consumed).
    const secondAttempt = await stage({
      answerDoc: createTextDocument("Quicksort is not stable."),
      questionDoc: createTextDocument("Is quicksort stable?")
    });
    expect(secondAttempt).not.toBe(firstAttempt);

    const result = await commit(secondAttempt, { kind: "create" });
    expect(result).toEqual({ status: "conflict" });
    // The conflicting attempt is left pending (unconsumed) and no second card was written.
    expect(await listCards()).toHaveLength(1);
    const attempt = await getCardCreationAttempt(db, DEFAULT_USER_ID, secondAttempt);
    expect(attempt).toMatchObject({ state: "pending" });
  });

  it("reports gone when the original card's note was deleted before a retry", async () => {
    const attemptId = await stage();
    const first = await commit(attemptId, { kind: "create" });
    if (first.status !== "created") throw new Error("expected created");

    // Delete the created note so the receipt becomes a non-resurrecting tombstone.
    await db
      .delete(personalEntries)
      .where(
        and(
          eq(personalEntries.entryId, first.card.noteId),
          eq(personalEntries.userId, DEFAULT_USER_ID)
        )
      );

    const second = await commit(attemptId, { kind: "create" });
    expect(second).toEqual({ status: "gone" });
  });

  it("produces exactly one card under concurrent identical commits", async () => {
    const attemptId = await stage();
    const [a, b] = await Promise.all([
      commit(attemptId, { kind: "create" }),
      commit(attemptId, { kind: "create" })
    ]);

    // Both callers see a created result (one genuine, one receipt replay) and there is exactly one card.
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    if (a.status !== "created" || b.status !== "created") throw new Error("expected created");
    expect(a.card).toEqual(b.card);
    expect(await listCards()).toHaveLength(1);
    expect(await listNotes()).toHaveLength(1);
  });

  it("scopes candidate matching to the committing owner", async () => {
    // Another owner's matching material must not count as a candidate for this owner's commit.
    await createDirectCard(directCardDeps(), otherUser, {
      submissionId: "other-seed",
      questionDoc: createTextDocument("Seed question?"),
      answerDoc: createTextDocument(answerA),
      target: { kind: "current_note" }
    });
    const attemptId = await stage();
    const result = await commit(attemptId, { kind: "create" });
    // No candidate for THIS owner, so the create succeeds.
    expect(result.status).toBe("created");
  });
});
