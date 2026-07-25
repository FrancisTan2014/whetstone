import type {
  CreateDirectCardRequest,
  DirectCardResultDto,
  MaterialReviewCandidateDto,
  MaterialReviewDto,
  NearMaterialReviewCandidateDto,
  NoteGradingTarget
} from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, toEntryId, type EntryId } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import { insertNoteInTx, insertNotePromptInTx } from "../notes/noteCommands.js";
import { findNearMatchNotes } from "../notes/noteNearMatchQuery.js";
import { findExactMaterialNotes } from "../notes/noteQueries.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import {
  discardPendingAttempt,
  fingerprintReviewCandidates,
  getPendingAttemptForSubmission,
  insertPendingCardCreationAttempt,
  refreshAttemptReview,
  type CardCreationAttemptRecord
} from "./cardCreationAttemptStore.js";
import { acquireCardMaterialLock } from "./cardMaterialLock.js";
import {
  claimReceipt,
  findReceiptReplay,
  fingerprintPayload,
  resolveReceiptReplay
} from "./cardCreationReceipt.js";
import {
  loadMaterialReviewCandidates,
  loadNearMaterialReviewCandidates
} from "./materialReviewCandidates.js";
import { resolveGradingColumns, type ResolvedGradingColumns } from "./noteGradingColumns.js";

// The transaction handle drizzle passes into `db.transaction`, so the save's advisory lock, review recheck,
// receipt claim, and writes all run in ONE atomic write.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What the retry-safe direct card save needs: the database, id generation (for note/prompt/attempt Entries),
// an explicit clock so the seeded card's due instant is deterministic, and the review attempt TTL so an
// unresolved material review expires deterministically.
export type CreateDirectCardDependencies = Readonly<{
  attemptTtlMs: number;
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// A drafted retrieval contract validated once at the save boundary and shared by every writer (#712): the
// rich Question and Answer documents, their server-derived readable texts, the resolved reveal columns, and
// the non-reversible payload fingerprint that binds the whole draft (answer + question + target). Derived
// exactly once so a save, a Keep-separate write, and a Use-existing write all bind the identical fingerprint.
export type PreparedDirectCardDraft = Readonly<{
  answerDoc: DocumentNodeJSON;
  bodyText: string;
  cueText: string;
  fingerprint: string;
  questionDoc: DocumentNodeJSON;
  reveal: Extract<ResolvedGradingColumns, { status: "ok" }>;
}>;

export type PrepareDirectCardDraftResult =
  | Readonly<{ status: "ok"; draft: PreparedDirectCardDraft }>
  | Readonly<{ status: "invalid_question" }>
  | Readonly<{ status: "invalid_answer" }>
  | Readonly<{ status: "invalid_success_check" }>;

// Validate and project one drafted retrieval contract at the boundary (#689/#712). Every readable text
// (Question, Answer, Success check) is derived here from its document — the wire never carries client
// plaintext, so a caller can neither desynchronize the projections nor smuggle a Reference into the Success
// check — and a document whose derived text is only whitespace is rejected before any write. The payload
// fingerprint binds the full draft so a later decision that resubmits an EDITED Answer is caught as a
// changed payload.
export function prepareDirectCardDraft(
  input: Readonly<{ answerDoc: unknown; questionDoc: unknown; target: NoteGradingTarget }>
): PrepareDirectCardDraftResult {
  const questionDoc = input.questionDoc as DocumentNodeJSON;
  const answerDoc = input.answerDoc as DocumentNodeJSON;
  const cueText = documentReadableText(questionDoc);
  if (cueText.trim().length === 0) {
    return { status: "invalid_question" };
  }
  const bodyText = documentReadableText(answerDoc);
  if (bodyText.trim().length === 0) {
    return { status: "invalid_answer" };
  }
  const reveal = resolveGradingColumns(input.target);
  if (reveal.status !== "ok") {
    return { status: "invalid_success_check" };
  }
  const fingerprint = fingerprintPayload({
    answer: answerDoc,
    question: questionDoc,
    target: input.target
  });
  return {
    status: "ok",
    draft: { answerDoc, bodyText, cueText, fingerprint, questionDoc, reveal }
  };
}

// The result of the single note+prompt+card write both the direct save and the Keep-separate decision
// compose (#689/#712). `ok` carries the created — or, on a same-payload receipt replay, the ORIGINAL —
// result. `conflict` is a replay of the same `submissionId` with a CHANGED payload; `gone` is a replay
// whose original note has since been deleted (the receipt is a non-resurrecting tombstone).
export type DirectCardWriteOutcome =
  | Readonly<{ status: "ok"; value: DirectCardResultDto }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

// Write EXACTLY one standalone note (#689) inside the caller's transaction: one manual note from the drafted
// Answer, one prompt with the chosen reveal kind and the rich Question as its cue, one active shared review
// card at the recall retention due at the clock, and one owner-scoped creation receipt — or, on a
// same-`submissionId` replay, the original result untouched (`ok`), a `conflict`, or a `gone` tombstone. The
// caller supplies the note/prompt ids and the prepared draft, so the save (no matching material) and the
// Keep-separate decision (deliberate distinct material) mint through the identical writer.
export async function writeDirectCardInTx(
  tx: Transaction,
  params: Readonly<{
    draft: PreparedDirectCardDraft;
    noteEntryId: EntryId;
    now: Date;
    promptId: string;
    submissionId: string;
    userId: string;
  }>
): Promise<DirectCardWriteOutcome> {
  const { draft, noteEntryId, now, promptId, submissionId, userId } = params;
  const claimed = await claimReceipt(tx, {
    createdAt: now,
    noteEntryId,
    payloadFingerprint: draft.fingerprint,
    promptEntryId: promptId,
    submissionId,
    userId
  });

  if (!claimed) {
    const replay = await resolveReceiptReplay(tx, {
      fingerprint: draft.fingerprint,
      submissionId,
      userId
    });
    if (replay.kind === "ok") {
      return { status: "ok", value: replay.value };
    }
    return { status: replay.kind };
  }

  await insertNoteInTx(tx, {
    anchor: null,
    bodyDoc: draft.answerDoc,
    bodyText: draft.bodyText,
    captureSource: "manual",
    kind: "note",
    noteEntryId,
    now,
    userId
  });
  await insertNotePromptInTx(tx, {
    answerDoc: draft.reveal.answerDoc,
    answerText: draft.reveal.answerText,
    cueDoc: draft.questionDoc,
    cueText: draft.cueText,
    noteEntryId,
    now,
    promptId,
    revealKind: draft.reveal.revealKind
  });
  const state = await seedReviewCard(tx, {
    now,
    requestedRetention: RECALL_REQUEST_RETENTION,
    targetEntryId: promptId,
    userId
  });

  return { status: "ok", value: { noteId: noteEntryId, promptId, review: state } };
}

// The outcome of a New-card save (#712, wrapping #689). `created` minted a fresh note+prompt+card because no
// matching material existed; `needs_material_review` created nothing and returned the review so the learner
// decides whether to reuse existing material or keep separate. The three `invalid_*`, `conflict`, and `gone`
// outcomes are the underlying write's boundary and receipt-replay failures.
export type DirectCardSaveOutcome =
  | Readonly<{ status: "created"; result: DirectCardResultDto }>
  | Readonly<{ status: "needs_material_review"; review: MaterialReviewDto }>
  | Readonly<{ status: "invalid_question" }>
  | Readonly<{ status: "invalid_answer" }>
  | Readonly<{ status: "invalid_success_check" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

// Build the review DTO returned to the learner from a persisted attempt and its enriched candidates. The
// attempt's own `candidateFingerprint`/`revision` are echoed so the client can notice the evidence changed
// and so a decision is revision-fenced. Shared with the decision commands so every review the client sees is
// built one way.
export function toMaterialReviewDto(
  attempt: CardCreationAttemptRecord,
  candidates: ReadonlyArray<MaterialReviewCandidateDto>,
  nearCandidates: ReadonlyArray<NearMaterialReviewCandidateDto>
): MaterialReviewDto {
  return {
    attemptId: attempt.id,
    candidateFingerprint: attempt.candidateFingerprint,
    candidates: [...candidates],
    nearCandidates: [...nearCandidates],
    revision: attempt.revision
  };
}

// Save a New card (#712), authoritatively reviewing exact existing material INSIDE the write transaction.
// The whole decision runs under a per-(owner, drafted-material) advisory lock, so two concurrent saves of the
// same Answer serialize: the first mints the note; the second reprojects, sees it, and returns
// `needs_material_review` instead of a duplicate. With no matching material the card is created directly
// through the canonical #689 writer. With a match, no card is created — a pending review attempt is persisted
// (or the existing one for this submission refreshed) and the reviewed candidates are returned so the learner
// chooses Use existing material or Keep separate. The review is never a client-only warning: the advisory
// query is advisory; THIS transaction is the source of truth.
//
// Retry-safety: a save retry with the same `submissionId` AND the same draft resumes the SAME review
// (refreshing its candidates under the revision fence) rather than minting a second attempt — the
// partial-unique index guarantees one pending review per (owner, submission). If the learner backed out of
// the review and EDITED the draft under that same submission, the pending attempt is bound to the old draft
// and is discarded so a fresh review identity is minted for the current draft — otherwise a later decision
// would fail `changed_payload` against the stale attempt forever. Once a card is created the receipt makes
// further identical saves replay the original result.
export async function createDirectCard(
  dependencies: CreateDirectCardDependencies,
  userId: string,
  request: CreateDirectCardRequest
): Promise<DirectCardSaveOutcome> {
  const prepared = prepareDirectCardDraft(request);
  if (prepared.status !== "ok") {
    return { status: prepared.status };
  }
  const draft = prepared.draft;
  const now = dependencies.now();

  return dependencies.db.transaction(async (tx) => {
    await acquireCardMaterialLock(tx, userId, draft.fingerprint);

    // Receipt replay takes precedence over the review gate: a retry of an already-created save must replay
    // its original result, never re-match the just-created note (whose body equals this draft) as "existing
    // material" and loop back into review.
    const replay = await findReceiptReplay(tx, {
      fingerprint: draft.fingerprint,
      submissionId: request.submissionId,
      userId
    });
    if (replay !== null) {
      if (replay.kind === "ok") {
        return { status: "created", result: replay.value };
      }
      return { status: replay.kind };
    }

    const pending = await getPendingAttemptForSubmission(tx, userId, request.submissionId);
    const matches = await findExactMaterialNotes(tx, { bodyDoc: draft.answerDoc, userId });
    const near = await findNearMatchNotes(tx, { bodyDoc: draft.answerDoc, userId });

    if (matches.length > 0 || near.length > 0) {
      const exactNoteIds = matches.map((note) => note.noteEntryId);
      const nearNoteIds = near.map((note) => note.noteEntryId);
      const candidates = await loadMaterialReviewCandidates(tx, userId, matches);
      const nearCandidates = await loadNearMaterialReviewCandidates(
        tx,
        userId,
        draft.answerDoc,
        near
      );

      // A pending attempt is only resumable when it is bound to the SAME draft. The composer keeps the
      // submissionId across a Back-then-edit, so a pending attempt whose draftFingerprint no longer matches
      // the just-submitted draft is stale: resuming it would hand back a review whose later decision fails
      // `changed_payload` forever (the old row never leaves `pending`). Discard the stale attempt and mint a
      // fresh review identity bound to the current draft instead.
      const resumable =
        pending !== null && pending.draftFingerprint === draft.fingerprint ? pending : null;
      if (pending !== null && resumable === null) {
        await discardPendingAttempt(tx, userId, pending.id);
      }

      if (resumable === null) {
        const attempt = await insertPendingCardCreationAttempt(tx, {
          draftFingerprint: draft.fingerprint,
          exactNoteIds,
          expiresAt: new Date(now.getTime() + dependencies.attemptTtlMs),
          id: dependencies.createId(),
          nearNoteIds,
          now,
          submissionId: request.submissionId,
          userId
        });
        return {
          status: "needs_material_review",
          review: toMaterialReviewDto(attempt, candidates, nearCandidates)
        };
      }

      // A save retry with the same draft: resume the same review, refreshing its persisted candidates (and
      // bumping the fence) only when the evidence changed, so the revision the client will decide against is
      // exactly current. The fingerprint binds BOTH groups plus the near evidence policy.
      const changed =
        fingerprintReviewCandidates({ exactNoteIds, nearNoteIds }) !==
        resumable.candidateFingerprint;
      let attempt = resumable;
      if (changed) {
        const refreshed = await refreshAttemptReview(tx, {
          exactNoteIds,
          expectedRevision: resumable.revision,
          id: resumable.id,
          nearNoteIds,
          now,
          userId
        });
        /* v8 ignore next -- refreshAttemptReview only misses under a concurrent decision the advisory lock
           serializes out; the `?? resumable` fallback keeps the type total. */
        attempt = refreshed ?? resumable;
      }
      return {
        status: "needs_material_review",
        review: toMaterialReviewDto(attempt, candidates, nearCandidates)
      };
    }

    // No exact or near material matches. A stale pending review parked by an earlier save of this submission
    // (whose matches have since been deleted) is now moot — discard it so a later decision cannot act on
    // vanished evidence — then create the card directly through the canonical writer.
    if (pending !== null) {
      await discardPendingAttempt(tx, userId, pending.id);
    }
    const write = await writeDirectCardInTx(tx, {
      draft,
      noteEntryId: toEntryId(dependencies.createId()),
      now,
      promptId: dependencies.createId(),
      submissionId: request.submissionId,
      userId
    });
    /* v8 ignore next 3 -- the outer `findReceiptReplay` returns non-null for ANY existing receipt on this
       (owner, submission), so reaching here means none exists and `claimReceipt` inside the writer always
       succeeds; `writeDirectCardInTx` therefore never returns conflict/gone on the save path. */
    if (write.status !== "ok") {
      return { status: write.status };
    }
    return { status: "created", result: write.value };
  });
}
