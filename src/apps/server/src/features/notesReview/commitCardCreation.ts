import type {
  MaterialReviewCandidateDto,
  McpCommitCardResult,
  McpCommitDecision,
  McpRefreshedPreview,
  NearMaterialReviewCandidateDto,
  NoteGradingTarget
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { findNearMatchNotes } from "../notes/noteNearMatchQuery.js";
import { findExactMaterialNotes } from "../notes/noteQueries.js";
import { writeAuthorNoteCardInTx } from "./authorNoteCard.js";
import {
  consumeAttempt,
  expireCardCreationAttempts,
  fingerprintReviewCandidates,
  getCardCreationAttempt,
  refreshAttemptReview,
  type CardCreationAttemptRecord,
  type CardCreationDecision
} from "./cardCreationAttemptStore.js";
import { acquireCardMaterialLock } from "./cardMaterialLock.js";
import {
  prepareDirectCardDraft,
  writeDirectCardInTx,
  type DirectCardWriteOutcome,
  type PreparedDirectCardDraft
} from "./createDirectCard.js";
import {
  loadMaterialReviewCandidates,
  loadNearMaterialReviewCandidates
} from "./materialReviewCandidates.js";

// The commit half of the local-MCP card surface (#718). After the learner approves a preview (#717) in the
// trusted agent conversation, this command consumes exactly that staged attempt and composes the SAME
// canonical direct-card (#689) / existing-Note (#688) writer the in-app flow uses. MCP owns transport and the
// audit channel only: the commit carries NO content — only the opaque `attemptId` and one decision — so the
// committed card is the previewed draft verbatim, recreated from the attempt's staged `draftPayload`, never a
// resubmitted (and possibly changed) payload. The whole decision runs under the SAME per-(owner, material)
// advisory lock a New-card save uses, so a concurrent in-app save and an MCP commit of the same material
// serialize, and a re-run of authoritative matching under that lock re-parks the preview for fresh approval
// whenever the reviewed candidate set moved since approval. Every write path is receipt-idempotent, so a
// lost response or a concurrent commit yields exactly one card. This command is the single place the behavior
// lives; the MCP transport only serializes the request and result.

// The transaction handle drizzle passes into `db.transaction`.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What a commit needs: the database, id generation (for the note/prompt Entries a create/keep-separate
// mints), and an explicit clock so the seeded card's due instant and the expiry check are deterministic. No
// attempt TTL — a commit resolves an existing attempt, it never mints one; no lexical service — the refreshed
// preview reuses the draft's fixed Answer, whose related material cannot have changed.
export type CommitCardCreationDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// One commit request: the opaque preview `attemptId` and the learner's single approved decision.
export type CommitCardCreationRequest = Readonly<{
  attemptId: string;
  decision: McpCommitDecision;
}>;

// The non-success outcomes the commit can settle on. Each is returned with ZERO writes (or a rolled-back
// transaction), so a rejected commit never leaves a half-created card.
type CommitFailure =
  | Readonly<{ status: "needs_approval"; preview: McpRefreshedPreview }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "expired" }>
  | Readonly<{ status: "candidates_exist" }>
  | Readonly<{ status: "not_a_candidate" }>
  | Readonly<{ status: "no_material" }>
  | Readonly<{ status: "decision_conflict" }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "gone" }>;

// A thrown sentinel that rolls the commit transaction back while preserving the outcome. The reuse writer can
// report `not_found` when the chosen Note vanished under the lock AFTER the recheck confirmed it — an
// untestable single-threaded race — and returning would COMMIT the writer's freshly-claimed receipt over a
// prompt that was never inserted, so the commit throws to discard it.
class CommitRollback extends Error {
  /* v8 ignore next 4 -- constructed only at the reuse `not_found` rollback throw below, an untestable
     concurrent-delete race the advisory lock and single-threaded recheck make unreachable in tests. */
  constructor(readonly outcome: CommitFailure) {
    super("commit_card_creation_rollback");
    this.name = "CommitRollback";
  }
}

// The rendered card the client already approved, rebuilt from the fixed staged draft: Question, Answer, and
// the Success check only when the draft grades against one.
function renderedCard(draft: PreparedDirectCardDraft): McpRefreshedPreview["renderedCard"] {
  return {
    question: draft.cueText,
    answer: draft.bodyText,
    successCheck: draft.reveal.revealKind === "expected_response" ? draft.reveal.answerText : null
  };
}

// Assemble the refreshed-preview payload the client must present for approval again after the reviewed
// candidate set moved under the commit lock.
function buildRefreshedPreview(
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  candidates: ReadonlyArray<MaterialReviewCandidateDto>,
  nearCandidates: ReadonlyArray<NearMaterialReviewCandidateDto>
): McpRefreshedPreview {
  return {
    attemptId: attempt.id,
    expiresAt: attempt.expiresAt.toISOString(),
    approvalRequired: true,
    nextAction: "present_preview_and_request_approval",
    renderedCard: renderedCard(draft),
    candidates: [...candidates],
    nearCandidates: [...nearCandidates],
    candidateFingerprint: attempt.candidateFingerprint,
    revision: attempt.revision
  };
}

// Map a composed writer's outcome to the commit result for a SUCCESSFUL decision kind. `ok` is the created —
// or, on a receipt replay, the original — card. `conflict` means the attempt's request id was already
// committed for a different draft (a reused request id or, on a same-attempt retry, a reuse of a different
// Note); `gone` means the original card was deleted since. Both leave zero new writes.
function mapWriteOutcome(
  status: "created" | "reused" | "kept_separate",
  write: DirectCardWriteOutcome
): McpCommitCardResult {
  if (write.status === "ok") {
    return { status, card: write.value };
  }
  if (write.status === "conflict") {
    return { status: "conflict" };
  }
  return { status: "gone" };
}

// Compose the direct-card writer (a new standalone note+card) for a `create` or `keep_separate` commit,
// stamping the immutable `mcp` audit channel and the consumed attempt id on the receipt.
function commitDirectCard(
  dependencies: CommitCardCreationDependencies,
  tx: Transaction,
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  now: Date
): Promise<DirectCardWriteOutcome> {
  return writeDirectCardInTx(tx, {
    attemptId: attempt.id,
    channel: "mcp",
    draft,
    noteEntryId: toEntryId(dependencies.createId()),
    now,
    promptId: dependencies.createId(),
    submissionId: attempt.submissionId,
    userId: attempt.userId
  });
}

// Compose the existing-Note writer (#688) for a `reuse` commit: add the drafted direction to the chosen
// reviewed Note, stamping the immutable `mcp` audit channel and the consumed attempt id. Reusing the Note
// never changes that Note's own origin — only the new card's receipt records the channel. The grading target
// is the one staged with the previewed draft, never a resubmitted one.
async function commitReuse(
  dependencies: CommitCardCreationDependencies,
  tx: Transaction,
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  target: NoteGradingTarget,
  noteEntryId: string,
  now: Date
): Promise<McpCommitCardResult> {
  const write = await writeAuthorNoteCardInTx(tx, {
    attemptId: attempt.id,
    channel: "mcp",
    cueText: draft.cueText,
    noteEntryId,
    now,
    promptId: dependencies.createId(),
    questionDoc: draft.questionDoc,
    reveal: draft.reveal,
    submissionId: attempt.submissionId,
    target,
    userId: attempt.userId
  });
  /* v8 ignore next 4 -- the recheck just confirmed the Note is a candidate; it can only vanish before the
     writer's row lock under a concurrent delete no single-threaded test can drive. */
  if (write.status === "not_found") {
    throw new CommitRollback({ status: "not_a_candidate" });
  }
  return mapWriteOutcome("reused", write);
}

// Replay a commit for an already-consumed attempt: the recorded decision fixes the card, so a retry with the
// SAME decision re-runs the composed writer (which replays via the receipt and returns the original result),
// while a retry with a DIFFERENT decision — a different kind, or a reuse of a different Note — is rejected as
// a decision conflict with zero writes.
async function replayConsumed(
  dependencies: CommitCardCreationDependencies,
  tx: Transaction,
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  target: NoteGradingTarget,
  decision: McpCommitDecision,
  now: Date
): Promise<McpCommitCardResult> {
  if (attempt.decision !== decision.kind) {
    return { status: "decision_conflict" };
  }
  if (decision.kind === "reuse") {
    const write = await writeAuthorNoteCardInTx(tx, {
      attemptId: attempt.id,
      channel: "mcp",
      cueText: draft.cueText,
      noteEntryId: decision.noteEntryId,
      now,
      promptId: dependencies.createId(),
      questionDoc: draft.questionDoc,
      reveal: draft.reveal,
      submissionId: attempt.submissionId,
      target,
      userId: attempt.userId
    });
    if (write.status === "ok") {
      return { status: "reused", card: write.value };
    }
    // A reuse of a DIFFERENT Note than the original hashes to a different receipt payload -> `conflict`;
    // both it and a since-deleted original are decision conflicts / gone with zero new writes.
    /* v8 ignore next -- the original card's own delete makes `gone` reachable only across a delete between
       commit and retry; the reuse-different-Note `conflict` is the tested branch. */
    return write.status === "conflict" ? { status: "decision_conflict" } : { status: "gone" };
  }
  const outcomeStatus = decision.kind === "create" ? "created" : "kept_separate";
  const write = await commitDirectCard(dependencies, tx, attempt, draft, now);
  return mapWriteOutcome(outcomeStatus, write);
}

// Validate an approved decision against the freshly-rechecked (and unchanged) candidate set, then compose the
// canonical writer and consume the attempt. `create` requires an empty set; `reuse` requires the chosen Note
// among the candidates; `keep_separate` requires a non-empty set.
async function commitPendingDecision(
  dependencies: CommitCardCreationDependencies,
  tx: Transaction,
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  target: NoteGradingTarget,
  decision: McpCommitDecision,
  candidateIds: ReadonlyArray<string>,
  now: Date
): Promise<McpCommitCardResult> {
  const hasCandidates = candidateIds.length > 0;
  let result: McpCommitCardResult;
  let recordedDecision: CardCreationDecision;
  if (decision.kind === "create") {
    if (hasCandidates) {
      return { status: "candidates_exist" };
    }
    result = mapWriteOutcome("created", await commitDirectCard(dependencies, tx, attempt, draft, now));
    recordedDecision = "create";
  } else if (decision.kind === "keep_separate") {
    if (!hasCandidates) {
      return { status: "no_material" };
    }
    result = mapWriteOutcome(
      "kept_separate",
      await commitDirectCard(dependencies, tx, attempt, draft, now)
    );
    recordedDecision = "keep_separate";
  } else {
    if (!candidateIds.includes(decision.noteEntryId)) {
      return { status: "not_a_candidate" };
    }
    result = await commitReuse(dependencies, tx, attempt, draft, target, decision.noteEntryId, now);
    recordedDecision = "reuse";
  }
  // Only a genuine create/reuse/keep-separate consumes the review slot; a receipt-replay conflict/gone leaves
  // the attempt pending so the caller can resolve the reused id without stranding the slot.
  if (result.status === "created" || result.status === "reused" || result.status === "kept_separate") {
    await consumeAttempt(tx, {
      decision: recordedDecision,
      expectedRevision: attempt.revision,
      id: attempt.id,
      now,
      userId: attempt.userId
    });
  }
  return result;
}

// Commit a learner-approved preview (#718). Reconstructs the previewed draft from the attempt's staged
// payload (never a resubmitted one), acquires the per-(owner, material) advisory lock, and reloads the
// attempt under it. A consumed attempt replays idempotently; a pending attempt reruns authoritative matching
// — a moved candidate set re-parks the preview for fresh approval (`needs_approval`), otherwise the approved
// decision is validated against the reviewed set and composed through the canonical writer with the immutable
// `mcp` audit channel, then the attempt is consumed. A forged/foreign/non-preview/swept attempt is
// `not_found`; a lapsed one is `expired`; all failures write nothing.
export async function commitCardCreation(
  dependencies: CommitCardCreationDependencies,
  userId: string,
  request: CommitCardCreationRequest
): Promise<McpCommitCardResult> {
  const now = dependencies.now();

  // Read the attempt first to recover the staged draft: the advisory lock is keyed on the draft's material
  // fingerprint, so the draft must be in hand before the lock is taken. Only an `mcp` attempt that staged its
  // draft is committable through this tool; anything else (a forged/foreign id, or a `ui` review attempt) is
  // foreign to the commit surface.
  const initial = await getCardCreationAttempt(dependencies.db, userId, request.attemptId);
  if (initial === null || initial.source !== "mcp" || initial.draftPayload === null) {
    return { status: "not_found" };
  }
  const prepared = prepareDirectCardDraft(initial.draftPayload);
  /* v8 ignore next 3 -- a staged `mcp` attempt only ever holds a draft the preview already validated, so
     re-preparing it here cannot fail; the guard keeps the type total. */
  if (prepared.status !== "ok") {
    return { status: "not_found" };
  }
  const draft = prepared.draft;
  // The grading target is the one staged with the previewed draft; the commit never trusts a resubmitted one.
  const target = initial.draftPayload.target;

  let outcome: McpCommitCardResult;
  try {
    outcome = await dependencies.db.transaction(async (tx): Promise<McpCommitCardResult> => {
      await acquireCardMaterialLock(tx, userId, draft.fingerprint);

      const attempt = await getCardCreationAttempt(tx, userId, request.attemptId);
      /* v8 ignore next 3 -- the attempt was just read above and the lock serializes the only sweeper, so it
         cannot vanish between the two reads in a single-threaded test; the guard keeps the type total. */
      if (attempt === null) {
        return { status: "not_found" };
      }

      if (attempt.state === "consumed") {
        return replayConsumed(dependencies, tx, attempt, draft, target, request.decision, now);
      }

      if (attempt.expiresAt.getTime() <= now.getTime()) {
        return { status: "expired" };
      }

      const matches = await findExactMaterialNotes(tx, { bodyDoc: draft.answerDoc, userId });
      const near = await findNearMatchNotes(tx, { bodyDoc: draft.answerDoc, userId });
      const exactNoteIds = matches.map((note) => note.noteEntryId);
      const nearNoteIds = near.map((note) => note.noteEntryId);
      const nearKeys = near.map((note) => note.caseSensitiveKey);

      // Re-park the preview for fresh approval when the reviewed candidate set moved since approval (a
      // new/changed/deleted candidate in either group, or the near evidence policy shifted). The rendered
      // card is unchanged (the draft is fixed), so only the candidate evidence and the fence are refreshed.
      if (
        fingerprintReviewCandidates({ exactNoteIds, nearKeys, nearNoteIds }) !==
        attempt.candidateFingerprint
      ) {
        const candidates = await loadMaterialReviewCandidates(tx, userId, matches);
        const nearCandidates = await loadNearMaterialReviewCandidates(
          tx,
          userId,
          draft.answerDoc,
          near
        );
        const refreshed = await refreshAttemptReview(tx, {
          exactNoteIds,
          expectedRevision: attempt.revision,
          id: attempt.id,
          nearKeys,
          nearNoteIds,
          now,
          userId
        });
        /* v8 ignore next -- refreshAttemptReview only misses under a concurrent decision the advisory lock
           serializes out; the `?? attempt` fallback keeps the type total. */
        const current = refreshed ?? attempt;
        return {
          status: "needs_approval",
          preview: buildRefreshedPreview(current, draft, candidates, nearCandidates)
        };
      }

      return commitPendingDecision(
        dependencies,
        tx,
        attempt,
        draft,
        target,
        request.decision,
        [...exactNoteIds, ...nearNoteIds],
        now
      );
    });
  } catch (error) {
    /* v8 ignore next 3 -- the CommitRollback branch is reached only via the ignored reuse `not_found`
       rollback throw; a real DB error takes the rethrow path. */
    if (error instanceof CommitRollback) {
      outcome = error.outcome;
    } else {
      throw error;
    }
  }
  await expireCardCreationAttempts(dependencies.db, now);
  return outcome;
}
