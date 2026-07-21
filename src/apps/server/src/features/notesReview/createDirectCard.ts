import type { CreateDirectCardRequest, DirectCardResultDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import { insertNoteInTx, insertNotePromptInTx } from "../notes/noteCommands.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { claimReceipt, fingerprintPayload, resolveReceiptReplay } from "./cardCreationReceipt.js";
import { resolveGradingColumns } from "./noteGradingColumns.js";

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

  const fingerprint = fingerprintPayload({
    answer: request.answerDoc,
    question: request.questionDoc,
    target: request.target
  });
  const now = dependencies.now();
  const noteEntryId = toEntryId(dependencies.createId());
  const promptId = dependencies.createId();

  return dependencies.db.transaction(async (tx) => {
    const claimed = await claimReceipt(tx, {
      createdAt: now,
      noteEntryId,
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
