import { createHash } from "node:crypto";

import type { CreateDirectCardRequest, DirectCardResultDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cardCreationReceipts, personalEntries, reviewCards } from "../../db/schema.js";
import { insertNoteInTx, insertNotePromptInTx } from "../notes/noteCommands.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { reviewStateFromCard } from "../review/reviewCardQueries.js";
import { resolveGradingColumns } from "./noteGradingColumns.js";

// The transaction handle drizzle passes into `db.transaction`, so the whole create-or-replay decision runs
// in ONE atomic write.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What the retry-safe direct card command needs: the database, id generation (for the note and prompt
// Entries), and an explicit clock so the seeded card's due instant is deterministic.
export type CreateDirectCardDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// The outcome of a direct card creation (#689). `ok` carries the created — or, on a same-payload replay,
// the ORIGINAL — result. The three `invalid_*` outcomes reject a document whose server-derived text is
// blank (the wire never carries plaintext, so blankness is judged here). `conflict` is a replay of the same
// `submissionId` with a CHANGED payload — the original result is preserved untouched. `gone` is a replay
// whose original note has since been deleted: the receipt tombstone reports it is gone and never recreates
// it.
export type CreateDirectCardOutcome =
  | Readonly<{ status: "ok"; value: DirectCardResultDto }>
  | Readonly<{ status: "invalid_question" }>
  | Readonly<{ status: "invalid_answer" }>
  | Readonly<{ status: "invalid_success_check" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

// A canonical, key-sorted serialization of any JSON value, so two logically equal payloads hash
// identically regardless of object-key order. Used only to feed the fingerprint digest.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

// A non-reversible fingerprint of a submission's payload — the question, the answer, and the grading target
// — so a replay with the SAME `submissionId` can be classified as an identical retry (same fingerprint) or
// a changed-payload conflict (different fingerprint) WITHOUT persisting any learning content: only this
// opaque sha256 digest is stored, never the documents themselves.
function fingerprintPayload(request: CreateDirectCardRequest): string {
  const canonical = canonicalize({
    answer: request.answerDoc,
    question: request.questionDoc,
    target: request.target
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Whether the receipt's original note still exists for this owner. A deleted note leaves the receipt behind
// as a non-resurrecting tombstone (the receipt has no foreign key into the note's cascade), so a replay of
// a deleted result reads `gone` here instead of resurrecting it.
async function noteStillExists(
  tx: Transaction,
  noteEntryId: string,
  userId: string
): Promise<boolean> {
  const rows = await tx
    .select({ entryId: personalEntries.entryId })
    .from(personalEntries)
    .where(and(eq(personalEntries.entryId, noteEntryId), eq(personalEntries.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// Project the ORIGINAL result of a receipt on a same-payload replay: the recorded note/prompt ids plus the
// live FSRS state of the seeded card. The card still exists (its note does), so the composer (#690) sees an
// identical result whether it is the first call or a retry.
async function projectOriginalResult(
  tx: Transaction,
  receipt: Readonly<{ noteEntryId: string; promptEntryId: string }>,
  userId: string
): Promise<DirectCardResultDto> {
  const cards = await tx
    .select()
    .from(reviewCards)
    .where(
      and(eq(reviewCards.targetEntryId, receipt.promptEntryId), eq(reviewCards.userId, userId))
    )
    .limit(1);
  const card = cards[0]!;
  return {
    noteId: receipt.noteEntryId,
    promptId: receipt.promptEntryId,
    review: reviewStateFromCard(card)
  };
}

// Create one review card directly from an authored question/answer pair (#689), retry-safe via the client's
// stable `submissionId`. One success writes EXACTLY: one manual standalone note from `answerDoc`; one prompt
// with the chosen reveal kind, its `contains` link, and the rich question as its cue; one active shared
// review card at the recall retention, due at the command clock; and one owner-scoped creation receipt. No
// review event is ever written. Every readable text (Question, Answer, Success check) is derived here, never
// trusted from the client, and a blank document is rejected before any write. The whole write is ONE
// transaction, so a failure at any insert rolls the entire submission back — including the receipt.
//
// Retry/deletion lifecycle: the receipt records the `submissionId`, the result ids, and a non-reversible
// payload fingerprint. A replay of the same owner + `submissionId` + payload returns the ORIGINAL result
// untouched; the same id with a changed payload is a `conflict`; a replay whose note has since been deleted
// is `gone` (the receipt is a non-resurrecting tombstone). Concurrent and sequential retries serialize on
// the receipt's primary key (`onConflictDoNothing`) to exactly one note/prompt/card/receipt.
export async function createDirectCard(
  dependencies: CreateDirectCardDependencies,
  userId: string,
  request: CreateDirectCardRequest
): Promise<CreateDirectCardOutcome> {
  const questionDoc = request.questionDoc as DocumentNodeJSON;
  const answerDoc = request.answerDoc as DocumentNodeJSON;
  const cueText = documentReadableText(questionDoc);
  if (cueText.trim().length === 0) {
    return { status: "invalid_question" };
  }
  const bodyText = documentReadableText(answerDoc);
  if (bodyText.trim().length === 0) {
    return { status: "invalid_answer" };
  }
  const reveal = resolveGradingColumns(request.target);
  if (reveal.status !== "ok") {
    return { status: "invalid_success_check" };
  }

  const fingerprint = fingerprintPayload(request);
  const now = dependencies.now();
  const noteEntryId = toEntryId(dependencies.createId());
  const promptId = dependencies.createId();

  return dependencies.db.transaction(async (tx) => {
    // Serialize concurrent/sequential retries on the receipt's primary key: the first submission wins the
    // insert; a retry (or concurrent loser) inserts nothing and falls through to resolve the original.
    const claimed = await tx
      .insert(cardCreationReceipts)
      .values({
        createdAt: now,
        noteEntryId,
        payloadFingerprint: fingerprint,
        promptEntryId: promptId,
        submissionId: request.submissionId,
        userId
      })
      .onConflictDoNothing()
      .returning({ noteEntryId: cardCreationReceipts.noteEntryId });

    if (claimed.length === 0) {
      const existingRows = await tx
        .select({
          noteEntryId: cardCreationReceipts.noteEntryId,
          payloadFingerprint: cardCreationReceipts.payloadFingerprint,
          promptEntryId: cardCreationReceipts.promptEntryId
        })
        .from(cardCreationReceipts)
        .where(
          and(
            eq(cardCreationReceipts.userId, userId),
            eq(cardCreationReceipts.submissionId, request.submissionId)
          )
        )
        .limit(1);
      const existing = existingRows[0]!;
      if (existing.payloadFingerprint !== fingerprint) {
        return { status: "conflict" };
      }
      if (!(await noteStillExists(tx, existing.noteEntryId, userId))) {
        return { status: "gone" };
      }
      return { status: "ok", value: await projectOriginalResult(tx, existing, userId) };
    }

    await insertNoteInTx(tx, {
      anchor: null,
      bodyDoc: answerDoc,
      bodyText,
      captureSource: "manual",
      kind: "note",
      noteEntryId,
      now,
      userId
    });
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

    return { status: "ok", value: { noteId: noteEntryId, promptId, review: state } };
  });
}
