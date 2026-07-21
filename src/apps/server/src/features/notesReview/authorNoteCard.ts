import type { AuthorNoteCardRequest, DirectCardResultDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { personalEntries } from "../../db/schema.js";
import { insertNotePromptInTx } from "../notes/noteCommands.js";
import { getNoteForOwner } from "../notes/noteQueries.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { claimReceipt, fingerprintPayload, resolveReceiptReplay } from "./cardCreationReceipt.js";
import { resolveGradingColumns } from "./noteGradingColumns.js";

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

// A thrown sentinel that rolls the creating transaction back while preserving the outcome to return. Unlike
// the direct-card command — whose genuine-create path always succeeds once the receipt is claimed — this
// command can legitimately fail AFTER claiming the receipt (the note was deleted between authorize and
// lock). Returning from the transaction callback would COMMIT the freshly claimed receipt, stranding a
// tombstone that points at a prompt that was never created; throwing rolls the receipt back so a later retry
// re-decides cleanly.
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
  // rejected up front. The genuine-create branch re-checks existence under a row lock, so a note deleted
  // between here and the lock still resolves to `not_found` rather than a dangling prompt.
  const noteEntryId = toEntryId(request.noteEntryId);
  const note = await getNoteForOwner(dependencies.db, noteEntryId, userId);
  if (note === undefined || note.kind !== "note") {
    return { status: "not_found" };
  }

  const fingerprint = fingerprintPayload({
    note: request.noteEntryId,
    question: request.questionDoc,
    target: request.target
  });
  const now = dependencies.now();
  const promptId = dependencies.createId();

  try {
    return await dependencies.db.transaction(async (tx) => {
      const claimed = await claimReceipt(tx, {
        createdAt: now,
        noteEntryId: request.noteEntryId,
        payloadFingerprint: fingerprint,
        promptEntryId: promptId,
        submissionId: request.submissionId,
        userId
      });

      if (!claimed) {
        const replay = await resolveReceiptReplay(tx, {
          fingerprint,
          submissionId: request.submissionId,
          userId
        });
        if (replay.kind === "ok") {
          return { status: "ok", value: replay.value };
        }
        return { status: replay.kind };
      }

      await lockOwnedNote(tx, request.noteEntryId, userId);

      await insertNotePromptInTx(tx, {
        answerDoc: reveal.answerDoc,
        answerText: reveal.answerText,
        cueDoc: questionDoc,
        cueText,
        noteEntryId,
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

      return { status: "ok", value: { noteId: request.noteEntryId, promptId, review: state } };
    });
  } catch (error) {
    if (error instanceof AuthorNoteCardRollback) {
      return error.outcome;
    }
    throw error;
  }
}

// Take the note's row lock and confirm it still exists for this owner, so the prompt insert runs under a
// serialized view of the note. A note deleted between the up-front authorize and this lock yields no row:
// the create cannot proceed against a missing note, so it rolls back to `not_found` (the freshly claimed
// receipt is discarded with it).
async function lockOwnedNote(tx: Transaction, noteEntryId: string, userId: string): Promise<void> {
  const rows = await tx
    .select({ entryId: personalEntries.entryId })
    .from(personalEntries)
    .where(and(eq(personalEntries.entryId, noteEntryId), eq(personalEntries.userId, userId)))
    .for("update")
    .limit(1);
  if (rows.length === 0) {
    throw new AuthorNoteCardRollback({ status: "not_found" });
  }
}
