import type {
  AuthorNoteCardRequest,
  DirectCardResultDto,
  NoteGradingTarget
} from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { personalEntries } from "../../db/schema.js";
import { insertNotePromptInTx } from "../notes/noteCommands.js";
import { getNoteForOwner } from "../notes/noteQueries.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { claimReceipt, fingerprintPayload, resolveReceiptReplay } from "./cardCreationReceipt.js";
import { resolveGradingColumns, type ResolvedGradingColumns } from "./noteGradingColumns.js";

// The transaction handle drizzle passes into `db.transaction`, so the whole claim-or-replay decision runs
// in ONE atomic write.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What the retry-safe first-card command needs: the database, id generation (for the prompt Entry only —
// the note already exists), and an explicit clock so the seeded card's due instant is deterministic.
export type AuthorNoteCardDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// The outcome of authoring a rich review card over an EXISTING saved note (#687, multiplicity in #688).
// `ok` carries the created — or, on a same-payload replay, the ORIGINAL — result. A note may own many
// authored cards, so a distinct submission always creates a NEW card; there is no one-prompt-per-note
// conflict. `invalid_question`/`invalid_success_check` reject a document whose server-derived text is blank
// (the wire never carries plaintext). `not_found` is a forged, cross-user, or since-deleted note, or a
// bodyless Mark that cannot hold a recall card. `conflict` is a replay of the same `submissionId` with a
// CHANGED payload; `gone` is a replay whose note has since been deleted.
export type AuthorNoteCardOutcome =
  | Readonly<{ status: "ok"; value: DirectCardResultDto }>
  | Readonly<{ status: "invalid_question" }>
  | Readonly<{ status: "invalid_success_check" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

// The write half of authoring a card over an existing note, without the boundary validation or the up-front
// authorize: claim the receipt, replay on a retry, else lock the note row and re-confirm it exists, insert
// ONE prompt (with the rich Question as its cue and the resolved reveal columns) and seed ONE active review
// card. Reused by BOTH the standalone `authorNoteCard` command and the #712 Use-existing decision, so the
// reuse path adds a card through the identical writer. `not_found` means the note vanished under the lock
// AFTER the receipt was claimed — the caller MUST roll its transaction back so the freshly-claimed receipt
// is not committed as a tombstone pointing at a prompt that was never created.
export type AuthorNoteCardWriteOutcome =
  | Readonly<{ status: "ok"; value: DirectCardResultDto }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>
  | Readonly<{ status: "not_found" }>;

export async function writeAuthorNoteCardInTx(
  tx: Transaction,
  params: Readonly<{
    cueText: string;
    noteEntryId: string;
    now: Date;
    promptId: string;
    questionDoc: DocumentNodeJSON;
    reveal: Extract<ResolvedGradingColumns, { status: "ok" }>;
    submissionId: string;
    target: NoteGradingTarget;
    userId: string;
  }>
): Promise<AuthorNoteCardWriteOutcome> {
  const { cueText, noteEntryId, now, promptId, questionDoc, reveal, submissionId, target, userId } =
    params;
  const fingerprint = fingerprintPayload({ note: noteEntryId, question: questionDoc, target });

  const claimed = await claimReceipt(tx, {
    createdAt: now,
    noteEntryId,
    payloadFingerprint: fingerprint,
    promptEntryId: promptId,
    submissionId,
    userId
  });

  if (!claimed) {
    const replay = await resolveReceiptReplay(tx, { fingerprint, submissionId, userId });
    if (replay.kind === "ok") {
      return { status: "ok", value: replay.value };
    }
    return { status: replay.kind };
  }

  if (!(await lockOwnedNote(tx, noteEntryId, userId))) {
    return { status: "not_found" };
  }

  await insertNotePromptInTx(tx, {
    answerDoc: reveal.answerDoc,
    answerText: reveal.answerText,
    cueDoc: questionDoc,
    cueText,
    noteEntryId: toEntryId(noteEntryId),
    now,
    promptId,
    revealKind: reveal.revealKind
  });
  const state = await seedReviewCard(tx, {
    now,
    requestedRetention: RECALL_REQUEST_RETENTION,
    targetEntryId: promptId,
    userId
  });

  return { status: "ok", value: { noteId: noteEntryId, promptId, review: state } };
}

// A thrown sentinel that rolls the creating transaction back while preserving the outcome to return. The
// genuine-create path can legitimately fail AFTER claiming the receipt (the note was deleted between
// authorize and lock). Returning from the transaction callback would COMMIT the freshly claimed receipt,
// stranding a tombstone that points at a prompt that was never created; throwing rolls the receipt back so a
// later retry re-decides cleanly.
class AuthorNoteCardRollback extends Error {
  constructor(readonly outcome: AuthorNoteCardOutcome) {
    super("author_note_card_rollback");
    this.name = "AuthorNoteCardRollback";
  }
}

// Author a rich review card over an existing saved note (#687; independent directions in #688), retry-safe
// via the client's stable `submissionId`. Unlike the standalone direct card (#689) this NEVER inserts or
// copies a note — it operates on the learner's already-owned note in place. One success writes EXACTLY: one
// prompt with the chosen reveal kind, its `contains` link back to the note, and the rich Question as its
// cue; one active shared review card at the recall retention, due at the command clock; and one owner-scoped
// creation receipt. No review event and no note write. The Question and Success-check texts are derived
// here, never trusted from the client, and a blank document is rejected before any write.
//
// Multiplicity and idempotency (#688): a note may own many authored prompts, so two DIFFERENT submissions
// against the same note intentionally create two DISTINCT cards even when their text matches — there is no
// one-authored-prompt-per-note conflict. Idempotency is per submission: the receipt claim serializes retries
// of the same `submissionId` to one result. The genuine-create branch still locks the note row
// (`FOR UPDATE`) and re-confirms it exists under that lock, so a note deleted between authorize and insert
// resolves to `not_found` rather than a foreign-key 500.
export async function authorNoteCard(
  dependencies: AuthorNoteCardDependencies,
  userId: string,
  request: AuthorNoteCardRequest
): Promise<AuthorNoteCardOutcome> {
  const questionDoc = request.questionDoc as DocumentNodeJSON;
  const cueText = documentReadableText(questionDoc);
  if (cueText.trim().length === 0) {
    return { status: "invalid_question" };
  }
  const reveal = resolveGradingColumns(request.target);
  if (reveal.status !== "ok") {
    return { status: "invalid_success_check" };
  }

  // Authorize the note before the write: a forged, cross-user, or since-deleted id, or a bodyless Mark, is
  // rejected up front without claiming a receipt. The genuine-create branch re-checks existence under a row
  // lock, so a note deleted between here and the lock still resolves to `not_found`.
  const note = await getNoteForOwner(dependencies.db, toEntryId(request.noteEntryId), userId);
  if (note === undefined || note.kind !== "note") {
    return { status: "not_found" };
  }

  const now = dependencies.now();
  const promptId = dependencies.createId();

  try {
    return await dependencies.db.transaction(async (tx) => {
      const outcome = await writeAuthorNoteCardInTx(tx, {
        cueText,
        noteEntryId: request.noteEntryId,
        now,
        promptId,
        questionDoc,
        reveal,
        submissionId: request.submissionId,
        target: request.target,
        userId
      });
      if (outcome.status === "not_found") {
        throw new AuthorNoteCardRollback({ status: "not_found" });
      }
      return outcome;
    });
  } catch (error) {
    if (error instanceof AuthorNoteCardRollback) {
      return error.outcome;
    }
    throw error;
  }
}

// Take the note's row lock and confirm it still exists for this owner, so the prompt insert runs under a
// serialized view of the note. Returns whether the note is still present: a note deleted between the up-front
// authorize and this lock yields no row, so the caller reports `not_found` and rolls back.
async function lockOwnedNote(
  tx: Transaction,
  noteEntryId: string,
  userId: string
): Promise<boolean> {
  const rows = await tx
    .select({ entryId: personalEntries.entryId })
    .from(personalEntries)
    .where(and(eq(personalEntries.entryId, noteEntryId), eq(personalEntries.userId, userId)))
    .for("update")
    .limit(1);
  return rows.length > 0;
}
