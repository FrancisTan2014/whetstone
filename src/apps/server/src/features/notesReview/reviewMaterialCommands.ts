import type {
  DirectCardResultDto,
  KeepSeparateMaterialRequest,
  MaterialReviewDto,
  UseExistingMaterialRequest
} from "@whetstone/contracts";
import { toEntryId, type EntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { findExactMaterialNotes, type ExactMaterialNote } from "../notes/noteQueries.js";
import { writeAuthorNoteCardInTx } from "./authorNoteCard.js";
import {
  consumeAttempt,
  expireCardCreationAttempts,
  fingerprintCandidateNotes,
  getCardCreationAttempt,
  refreshAttemptReview,
  type CardCreationAttemptRecord
} from "./cardCreationAttemptStore.js";
import { acquireCardMaterialLock } from "./cardMaterialLock.js";
import {
  prepareDirectCardDraft,
  toMaterialReviewDto,
  writeDirectCardInTx,
  type PreparedDirectCardDraft
} from "./createDirectCard.js";
import { loadMaterialReviewCandidates } from "./materialReviewCandidates.js";

// The two authoritative material-review decisions (#712): once a New-card save returns
// `needs_material_review`, the learner resolves it by adding the drafted retrieval contract to an existing
// note (Use existing material → the #688 writer) or minting a distinct note (Keep separate → the #689
// writer). Each decision runs the SAME authoritative recheck the save did — under the per-(owner, material)
// advisory lock, reprojecting and re-querying exact material inside the write transaction — so a decision is
// never taken against stale client evidence. The client holds only the opaque `attemptId` + `revision` and
// resubmits the full draft; it can neither decide candidate policy nor commit around review.

// The transaction handle drizzle passes into `db.transaction`.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What a material-review decision needs: the database, id generation (for the note/prompt Entries a decision
// creates), and an explicit clock. No attempt TTL — a decision resolves an existing attempt, it never mints
// one.
export type MaterialDecisionDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// The shared guard/refresh failures both decisions surface, plus the draft-validation and receipt-write
// failures. `needs_material_review` re-parks the review (its evidence changed since the learner decided);
// `not_found`/`expired`/`superseded`/`changed_payload` reject a forged, lapsed, stale, or edited decision;
// `conflict`/`gone` are the underlying writer's receipt-replay outcomes.
type DecisionFailure =
  | Readonly<{ status: "needs_material_review"; review: MaterialReviewDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "expired" }>
  | Readonly<{ status: "superseded" }>
  | Readonly<{ status: "changed_payload" }>
  | Readonly<{ status: "invalid_question" }>
  | Readonly<{ status: "invalid_answer" }>
  | Readonly<{ status: "invalid_success_check" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

export type UseExistingMaterialOutcome =
  | Readonly<{ status: "reused"; result: DirectCardResultDto }>
  | DecisionFailure;

export type KeepSeparateMaterialOutcome =
  | Readonly<{ status: "created"; result: DirectCardResultDto }>
  | DecisionFailure;

// A thrown sentinel that rolls a decision transaction back while preserving the outcome. The reuse writer can
// report `not_found` when the chosen note vanished under the lock AFTER the recheck confirmed it — an
// untestable single-threaded race — and returning would COMMIT the writer's freshly-claimed receipt over a
// prompt that was never inserted, so the decision throws to discard it and the client refetches.
class MaterialDecisionRollback extends Error {
  /* v8 ignore next 4 -- constructed only at the `not_found` rollback throw below, an untestable
     concurrent-delete race the advisory lock and single-threaded recheck make unreachable in tests. */
  constructor(readonly outcome: DecisionFailure) {
    super("material_decision_rollback");
    this.name = "MaterialDecisionRollback";
  }
}

// The guarded, still-pending attempt plus the draft and the fresh recheck evidence a decision acts on.
type DecisionContext = Readonly<{
  attempt: CardCreationAttemptRecord;
  draft: PreparedDirectCardDraft;
  matches: ReadonlyArray<ExactMaterialNote>;
  noteIds: ReadonlyArray<EntryId>;
}>;

type GuardResult =
  | Readonly<{ ok: true; context: DecisionContext }>
  | Readonly<{ ok: false; outcome: DecisionFailure }>;

// Guard one decision and reproject its evidence inside the (already lock-held) transaction against the
// draft the caller already validated before taking the lock: reject a missing/lapsed/superseded attempt and
// an EDITED Answer whose fingerprint no longer matches the attempt's bound draft, then re-run the
// exact-material query so the decision commits against the current world, never the client's stale snapshot.
async function guardDecision(
  tx: Transaction,
  userId: string,
  request: Readonly<{ attemptId: string; revision: number }>,
  draft: PreparedDirectCardDraft,
  now: Date
): Promise<GuardResult> {
  const attempt = await getCardCreationAttempt(tx, userId, request.attemptId);
  if (attempt === null) {
    return { ok: false, outcome: { status: "not_found" } };
  }
  if (attempt.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, outcome: { status: "expired" } };
  }
  // A stale revision or an already-decided (consumed) attempt is fenced out — a replayed or racing decision
  // is rejected, never reapplied.
  if (attempt.state !== "pending" || attempt.revision !== request.revision) {
    return { ok: false, outcome: { status: "superseded" } };
  }
  // The decision must carry the SAME draft the save reviewed: an edited Answer would recheck against
  // different material, so a changed fingerprint is rejected rather than silently re-reviewed.
  if (attempt.draftFingerprint !== draft.fingerprint) {
    return { ok: false, outcome: { status: "changed_payload" } };
  }

  const matches = await findExactMaterialNotes(tx, { bodyDoc: draft.answerDoc, userId });
  return {
    ok: true,
    context: { attempt, draft, matches, noteIds: matches.map((note) => note.noteEntryId) }
  };
}

// Re-park the review under a bumped revision when the evidence changed since the learner decided, forcing a
// fresh confirmation instead of committing against stale candidates.
async function refreshDecisionReview(
  tx: Transaction,
  userId: string,
  context: DecisionContext,
  now: Date
): Promise<Readonly<{ status: "needs_material_review"; review: MaterialReviewDto }>> {
  const candidates = await loadMaterialReviewCandidates(tx, userId, context.matches);
  const refreshed = await refreshAttemptReview(tx, {
    candidateNoteIds: context.noteIds,
    expectedRevision: context.attempt.revision,
    id: context.attempt.id,
    now,
    userId
  });
  /* v8 ignore next -- refreshAttemptReview only misses under a concurrent decision the advisory lock
     serializes out; the `?? attempt` fallback keeps the type total. */
  const current = refreshed ?? context.attempt;
  return { status: "needs_material_review", review: toMaterialReviewDto(current, candidates) };
}

function mapDecisionRollback<T extends DecisionFailure>(error: unknown): T | never {
  /* v8 ignore next 3 -- the instanceof branch is reached only via the ignored `not_found` rollback throw;
     a real DB error takes the rethrow path below instead. */
  if (error instanceof MaterialDecisionRollback) {
    return error.outcome as T;
  }
  throw error;
}

// Use existing material (#712): add the drafted retrieval contract to one reviewed candidate note instead of
// minting a new note. The chosen `noteEntryId` must still be among the freshly rechecked candidates — a note
// deleted or no longer matching since the review re-parks the review so the learner re-chooses. Otherwise the
// contract is added through the canonical #688 writer and the attempt is consumed as `reuse`. Two cards over
// the same note is the intended multiplicity, so this never de-duplicates a second capability.
export async function useExistingMaterial(
  dependencies: MaterialDecisionDependencies,
  userId: string,
  request: UseExistingMaterialRequest
): Promise<UseExistingMaterialOutcome> {
  const now = dependencies.now();
  let outcome: UseExistingMaterialOutcome;
  try {
    outcome = await dependencies.db.transaction(async (tx) => {
      const prepared = prepareDirectCardDraft(request);
      if (prepared.status !== "ok") {
        return { status: prepared.status };
      }
      await acquireCardMaterialLock(tx, userId, prepared.draft.fingerprint);

      const guard = await guardDecision(tx, userId, request, prepared.draft, now);
      if (!guard.ok) {
        return guard.outcome;
      }
      const { attempt, draft, noteIds } = guard.context;

      const chosen = toEntryId(request.noteEntryId);
      if (!noteIds.includes(chosen)) {
        return refreshDecisionReview(tx, userId, guard.context, now);
      }

      const write = await writeAuthorNoteCardInTx(tx, {
        cueText: draft.cueText,
        noteEntryId: request.noteEntryId,
        now,
        promptId: dependencies.createId(),
        questionDoc: draft.questionDoc,
        reveal: draft.reveal,
        submissionId: request.submissionId,
        target: request.target,
        userId
      });
      /* v8 ignore next 3 -- the recheck just confirmed the note is a candidate; it can only vanish before
         the writer's row lock under a concurrent delete no single-threaded test can drive. */
      if (write.status === "not_found") {
        throw new MaterialDecisionRollback({ status: "superseded" });
      }
      /* v8 ignore next 3 -- the parked save wrote no receipt, so this decision is the first to claim its
         submission's receipt and the writer always returns `ok`; conflict/gone need a receipt collision the
         guard's consume fence makes unreachable in the real flow. */
      if (write.status !== "ok") {
        return { status: write.status };
      }
      await consumeAttempt(tx, {
        decision: "reuse",
        expectedRevision: attempt.revision,
        id: attempt.id,
        now,
        userId
      });
      return { status: "reused", result: write.value };
    });
  } catch (error) {
    outcome = mapDecisionRollback<DecisionFailure>(error);
  }
  await expireCardCreationAttempts(dependencies.db, now);
  return outcome;
}

// Keep separate (#712): commit distinct material despite the review. If the reviewed candidate set changed
// since the learner decided (a new/changed match appeared), the review is re-parked for a fresh confirmation;
// otherwise a new standalone note is minted through the canonical #689 writer and the attempt is consumed as
// `keep_separate`. A recheck that now finds NO material at all simply creates — there is nothing left to be
// separate from.
export async function keepSeparateMaterial(
  dependencies: MaterialDecisionDependencies,
  userId: string,
  request: KeepSeparateMaterialRequest
): Promise<KeepSeparateMaterialOutcome> {
  const now = dependencies.now();
  const outcome = await dependencies.db.transaction(
    async (tx): Promise<KeepSeparateMaterialOutcome> => {
    const prepared = prepareDirectCardDraft(request);
    if (prepared.status !== "ok") {
      return { status: prepared.status };
    }
    await acquireCardMaterialLock(tx, userId, prepared.draft.fingerprint);

    const guard = await guardDecision(tx, userId, request, prepared.draft, now);
    if (!guard.ok) {
      return guard.outcome;
    }
    const { attempt, draft, noteIds } = guard.context;

    if (
      noteIds.length > 0 &&
      fingerprintCandidateNotes(noteIds) !== attempt.candidateFingerprint
    ) {
      return refreshDecisionReview(tx, userId, guard.context, now);
    }

    const write = await writeDirectCardInTx(tx, {
      draft,
      noteEntryId: toEntryId(dependencies.createId()),
      now,
      promptId: dependencies.createId(),
      submissionId: request.submissionId,
      userId
    });
    /* v8 ignore next 3 -- the parked save wrote no receipt, so Keep separate is the first to claim its
       submission's receipt and the writer always returns `ok`; conflict/gone are unreachable here. */
    if (write.status !== "ok") {
      return { status: write.status };
    }
    await consumeAttempt(tx, {
      decision: "keep_separate",
      expectedRevision: attempt.revision,
      id: attempt.id,
      now,
      userId
    });
    return { status: "created", result: write.value };
  }
  );
  await expireCardCreationAttempts(dependencies.db, now);
  return outcome;
}
