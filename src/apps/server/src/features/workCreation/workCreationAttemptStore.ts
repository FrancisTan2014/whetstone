import type {
  ReviewedCandidateSnapshot,
  WorkCreationAttemptState,
  WorkCreationSourceKind
} from "@whetstone/domain";
import {
  canBeginFinalize,
  canCompleteFinalize,
  canTransferStage,
  fingerprintReviewedCandidates,
  isActiveWorkCreationAttemptState,
  isTerminalWorkCreationAttemptState,
  ownsOrdinaryUploadStage,
  workCreationAttemptStates
} from "@whetstone/domain";
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { workCreationAttempts } from "../../db/schema.js";

// Durable persistence for owner-scoped Work CREATION-REVIEW attempts (#725). Duplicate review is
// operational state, not Work identity: this store holds one pending attempt's proposed metadata, the
// reviewed candidate evidence, and any ordinary upload stage until one serialized decision commits or
// discards it. It writes NO Work, ReadingUnit, Block, or source-claim row — nothing here is content.
//
// Every state change is FENCED by the `revision` compare-and-set: a review update, a decision begin, and a
// completion apply only while the row is still at the revision the client loaded and in the state the
// transition allows, so a stale client can never commit and a replayed decision is rejected instead of
// silently reapplied. Cleanup is explicit and visible: cancel/expiry return the exact stage path so the
// caller can remove those bytes, and `stage_path` is cleared only AFTER the filesystem removal succeeds —
// a failed cleanup leaves the attempt bound and retryable rather than orphaning the bytes, and no stage is
// ever removed by age.

export type WorkCreationAttemptRecord = Readonly<{
  id: string;
  userId: string;
  proposedTitle: string;
  proposedAuthorId: string | null;
  proposedAuthorName: string;
  proposedLanguage: string;
  proposedWorkType: string;
  sourceKind: WorkCreationSourceKind;
  sourceHash: string | null;
  candidateSnapshot: ReviewedCandidateSnapshot | null;
  candidateFingerprint: string | null;
  state: WorkCreationAttemptState;
  revision: number;
  stagePath: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

type AttemptRow = typeof workCreationAttempts.$inferSelect;

function toRecord(row: AttemptRow): WorkCreationAttemptRecord {
  return Object.freeze({
    id: row.id,
    userId: row.userId,
    proposedTitle: row.proposedTitle,
    proposedAuthorId: row.proposedAuthorId,
    proposedAuthorName: row.proposedAuthorName,
    proposedLanguage: row.proposedLanguage,
    proposedWorkType: row.proposedWorkType,
    sourceKind: row.sourceKind,
    sourceHash: row.sourceHash,
    candidateSnapshot: row.candidateSnapshot ?? null,
    candidateFingerprint: row.candidateFingerprint,
    state: row.state,
    revision: row.revision,
    stagePath: row.stagePath,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

// The single state a revision-fenced transition moves FROM, derived from the pure state machine so the
// store never hard-codes (and cannot drift from) the transition rules. Exactly one state matches each
// predicate; asserting that keeps a future state-machine change from silently widening a fenced transition.
function soleStateMatching(
  predicate: (state: WorkCreationAttemptState) => boolean
): WorkCreationAttemptState {
  const matches = workCreationAttemptStates.filter(predicate);
  /* v8 ignore next 3 -- guards a future state-machine edit; both predicates match exactly one state today,
     so this branch is unreachable without changing the domain module. */
  if (matches.length !== 1) {
    throw new Error("A fenced creation-attempt transition must have exactly one source state.");
  }
  return matches[0]!;
}

const BEGIN_FINALIZE_FROM = soleStateMatching(canBeginFinalize);
const COMPLETE_FINALIZE_FROM = soleStateMatching(canCompleteFinalize);
const TRANSFER_STAGE_FROM = soleStateMatching(canTransferStage);

// The terminal states, derived from the pure state machine so the clear-stage cleanup gate can never drift
// from the domain's definition of "done". A terminal attempt's state never changes again, so its leftover
// stage is cleanup to confirm — not input to a live decision.
const TERMINAL_STATES = workCreationAttemptStates.filter(isTerminalWorkCreationAttemptState);

export type ProposedMetadataInput = Readonly<{
  title: string;
  authorId: string | null;
  authorName: string;
  language: string;
  workType: string;
}>;

export type InsertPendingAttemptInput = Readonly<{
  id: string;
  userId: string;
  proposed: ProposedMetadataInput;
  sourceKind: WorkCreationSourceKind;
  sourceHash: string | null;
  candidates: ReviewedCandidateSnapshot | null;
  stagePath: string | null;
  expiresAt: Date;
  now: Date;
}>;

// A stage may only be bound to an ORDINARY upload attempt (markdown/epub). Rejecting it here — before the
// insert — keeps a manual/pdf attempt from ever being handed a stage path (the DB check is the backstop),
// so a phantom or double-owned file cannot be recorded.
export class InvalidStageOwnershipError extends Error {
  constructor(sourceKind: WorkCreationSourceKind) {
    super(`A ${sourceKind} creation attempt does not own an ordinary upload stage.`);
    this.name = "InvalidStageOwnershipError";
  }
}

// Create the single active `pending` attempt for an owner. The reviewed evidence and its fingerprint are
// stored together (the fingerprint is computed here from the snapshot, never trusted from the caller) or
// both absent. A second concurrent active attempt for the same owner violates the partial-unique index and
// throws, so the "one owner-scoped creation attempt" invariant is the database's, not only the caller's.
export async function insertPendingAttempt(
  db: DbClient,
  input: InsertPendingAttemptInput
): Promise<WorkCreationAttemptRecord> {
  if (input.stagePath !== null && !ownsOrdinaryUploadStage(input.sourceKind)) {
    throw new InvalidStageOwnershipError(input.sourceKind);
  }

  const [row] = await db
    .insert(workCreationAttempts)
    .values({
      id: input.id,
      userId: input.userId,
      proposedTitle: input.proposed.title,
      proposedAuthorId: input.proposed.authorId,
      proposedAuthorName: input.proposed.authorName,
      proposedLanguage: input.proposed.language as AttemptRow["proposedLanguage"],
      proposedWorkType: input.proposed.workType as AttemptRow["proposedWorkType"],
      sourceKind: input.sourceKind,
      sourceHash: input.sourceHash,
      candidateSnapshot: input.candidates,
      candidateFingerprint:
        input.candidates === null ? null : fingerprintReviewedCandidates(input.candidates),
      state: "pending",
      revision: 0,
      stagePath: input.stagePath,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now
    })
    .returning();
  return toRecord(row!);
}

export async function getAttempt(
  db: DbClient,
  userId: string,
  id: string
): Promise<WorkCreationAttemptRecord | null> {
  const [row] = await db
    .select()
    .from(workCreationAttempts)
    .where(and(eq(workCreationAttempts.id, id), eq(workCreationAttempts.userId, userId)));
  return row === undefined ? null : toRecord(row);
}

// The predicate for a still-active (`pending`/`finalizing`) attempt, used by the active-attempt query and
// the expiry sweep so both agree with the partial-unique index on exactly which rows are live.
function activeStateCondition(): SQL {
  return sql`${workCreationAttempts.state} in ('pending', 'finalizing')`;
}

// The predicate for a terminal (`completed`/`cancelled`/`expired`) attempt, built from the domain terminal
// set so `clearStagePath` gates on exactly the states whose stage is leftover cleanup — never a still-active
// attempt whose bytes a live decision may still transfer.
function terminalStateCondition(): SQL {
  return inArray(workCreationAttempts.state, TERMINAL_STATES);
}

// The owner's single active (`pending`/`finalizing`) attempt, if any — the row the partial-unique index
// guarantees is unique. A consumer loads this to resume review instead of creating a duplicate.
export async function getActiveAttemptForUser(
  db: DbClient,
  userId: string
): Promise<WorkCreationAttemptRecord | null> {
  const [row] = await db
    .select()
    .from(workCreationAttempts)
    .where(and(eq(workCreationAttempts.userId, userId), activeStateCondition()));
  return row === undefined ? null : toRecord(row);
}

// The fenced guard shared by every revision-checked transition: touch the row only while it is owned by
// this user, still at the revision the client loaded, and in the single state the transition allows.
function fencedWhere(
  userId: string,
  id: string,
  expectedRevision: number,
  fromState: WorkCreationAttemptState
): SQL | undefined {
  return and(
    eq(workCreationAttempts.id, id),
    eq(workCreationAttempts.userId, userId),
    eq(workCreationAttempts.revision, expectedRevision),
    eq(workCreationAttempts.state, fromState)
  );
}

export type UpdateReviewInput = Readonly<{
  userId: string;
  id: string;
  expectedRevision: number;
  proposed: ProposedMetadataInput;
  candidates: ReviewedCandidateSnapshot | null;
  now: Date;
}>;

// Update a still-`pending` attempt's proposal and reviewed evidence, bumping the revision so any client
// holding the old revision is fenced out. Recomputes the fingerprint from the snapshot here (never trusts
// a caller-supplied one). Returns the updated record, or null when the compare-and-set missed — a stale
// revision, or an attempt that already left `pending`.
export async function updateAttemptReview(
  db: DbClient,
  input: UpdateReviewInput
): Promise<WorkCreationAttemptRecord | null> {
  const [row] = await db
    .update(workCreationAttempts)
    .set({
      proposedTitle: input.proposed.title,
      proposedAuthorId: input.proposed.authorId,
      proposedAuthorName: input.proposed.authorName,
      proposedLanguage: input.proposed.language as AttemptRow["proposedLanguage"],
      proposedWorkType: input.proposed.workType as AttemptRow["proposedWorkType"],
      candidateSnapshot: input.candidates,
      candidateFingerprint:
        input.candidates === null ? null : fingerprintReviewedCandidates(input.candidates),
      revision: input.expectedRevision + 1,
      updatedAt: input.now
    })
    .where(fencedWhere(input.userId, input.id, input.expectedRevision, "pending"))
    .returning();
  return row === undefined ? null : toRecord(row);
}

export type FenceInput = Readonly<{
  userId: string;
  id: string;
  expectedRevision: number;
  now: Date;
}>;

// Claim the single decision slot: compare-and-set `pending` -> `finalizing`, bumping the revision. The
// intermediate `finalizing` state fences out a second concurrent committer while the consumer creates or
// reopens the Work. Returns the fenced record, or null on a stale revision / an attempt that is not
// `pending` (already finalizing, or terminal) — a replayed decision is rejected, never reapplied.
export async function beginFinalizeAttempt(
  db: DbClient,
  input: FenceInput
): Promise<WorkCreationAttemptRecord | null> {
  const [row] = await db
    .update(workCreationAttempts)
    .set({ state: "finalizing", revision: input.expectedRevision + 1, updatedAt: input.now })
    .where(fencedWhere(input.userId, input.id, input.expectedRevision, BEGIN_FINALIZE_FROM))
    .returning();
  return row === undefined ? null : toRecord(row);
}

// Complete the decision: compare-and-set `finalizing` -> `completed`. Applies only while this attempt
// still holds the decision slot at the revision the begin returned, so a stale or double completion is
// rejected. `stage_path` is intentionally left untouched here — the caller transfers or discards the stage
// explicitly, so a failed transfer never loses the bytes.
export async function completeAttempt(
  db: DbClient,
  input: FenceInput
): Promise<WorkCreationAttemptRecord | null> {
  const [row] = await db
    .update(workCreationAttempts)
    .set({ state: "completed", revision: input.expectedRevision + 1, updatedAt: input.now })
    .where(fencedWhere(input.userId, input.id, input.expectedRevision, COMPLETE_FINALIZE_FROM))
    .returning();
  return row === undefined ? null : toRecord(row);
}

export type CancelResult = Readonly<{ cancelled: boolean; stagePath: string | null }>;

// Cancel a non-terminal attempt for its owner. Terminal attempts (`completed`/`cancelled`/`expired`) are a
// no-op (returns `cancelled: false`). Returns the stage path still owned so the caller can remove those
// bytes; the path is left set on the row until `clearStagePath` confirms the filesystem removal, so a
// failed cleanup stays visible and retryable.
export async function cancelAttempt(
  db: DbClient,
  userId: string,
  id: string,
  now: Date
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(workCreationAttempts)
      .where(and(eq(workCreationAttempts.id, id), eq(workCreationAttempts.userId, userId)));
    if (attempt === undefined || !isActiveWorkCreationAttemptState(attempt.state)) {
      return { cancelled: false, stagePath: null };
    }
    await tx
      .update(workCreationAttempts)
      .set({ state: "cancelled", revision: attempt.revision + 1, updatedAt: now })
      .where(eq(workCreationAttempts.id, id));
    return { cancelled: true, stagePath: attempt.stagePath };
  });
}

export type ExpiredAttempt = Readonly<{ id: string; userId: string; stagePath: string | null }>;

// Sweep every active attempt whose TTL has passed to `expired`, returning each one's id and owned stage so
// the caller can remove those staged bytes with a targeted cleanup. Only attempts that are actually past
// `expires_at` are swept — nothing is expired by a generic age scan, and no stage bytes are touched here
// (the caller removes the exact returned paths, then calls `clearStagePath`), so an unrelated file is
// never deleted.
export async function expireAttempts(db: DbClient, now: Date): Promise<readonly ExpiredAttempt[]> {
  const rows = await db
    .update(workCreationAttempts)
    .set({ state: "expired", revision: sql`${workCreationAttempts.revision} + 1`, updatedAt: now })
    .where(and(lte(workCreationAttempts.expiresAt, now), activeStateCondition()))
    .returning({
      id: workCreationAttempts.id,
      userId: workCreationAttempts.userId,
      stagePath: workCreationAttempts.stagePath
    });
  return rows.map((row) =>
    Object.freeze({ id: row.id, userId: row.userId, stagePath: row.stagePath })
  );
}

export type DetachStageInput = Readonly<{
  userId: string;
  id: string;
  expectedRevision: number;
  now: Date;
}>;

export type DetachStageResult = Readonly<{ stagePath: string; revision: number }>;

// Transfer this owner's ordinary upload stage to immutable provenance as part of the serialized decision.
// Fenced exactly like the other decision transitions: it applies only while THIS owner's attempt still
// holds the live decision slot (`finalizing`) at the revision the begin-finalize returned, and it bumps the
// revision so a stale committer is fenced out of the rest of the decision. Returns the detached stage path
// and the new revision (feed it to `completeAttempt`) so the caller can move those bytes to provenance
// without ever leaving the file double-owned — or null when the compare-and-set missed: a foreign owner, a
// stale revision, an attempt not in `finalizing`, or one that owns no stage. A `pending` or terminal
// attempt is therefore never allowed to transfer bytes outside the serialized decision.
export async function detachStagePath(
  db: DbClient,
  input: DetachStageInput
): Promise<DetachStageResult | null> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ stagePath: workCreationAttempts.stagePath })
      .from(workCreationAttempts)
      .where(fencedWhere(input.userId, input.id, input.expectedRevision, TRANSFER_STAGE_FROM));
    if (attempt === undefined || attempt.stagePath === null) {
      return null;
    }
    const revision = input.expectedRevision + 1;
    await tx
      .update(workCreationAttempts)
      .set({ stagePath: null, revision, updatedAt: input.now })
      .where(fencedWhere(input.userId, input.id, input.expectedRevision, TRANSFER_STAGE_FROM));
    return Object.freeze({ stagePath: attempt.stagePath, revision });
  });
}

export type ClearStageInput = Readonly<{
  userId: string;
  id: string;
  now: Date;
}>;

export type ClearStageResult = Readonly<{ cleared: boolean }>;

// Clear the stage binding ONLY after the staged bytes were actually removed from disk, and ONLY for a
// terminal attempt owned by this user. Cancel/expiry leave `stage_path` set until the filesystem removal
// succeeds, so a failed cleanup stays visible and retryable; this confirms it. Scoped by owner and gated to
// terminal states so a route holding or forging an id can neither clear another owner's stage nor discard
// the bytes of a still-active (`pending`/`finalizing`) attempt out from under its live decision. A terminal
// attempt's state can never change again, so the owner + terminal gate is the whole fence — there is no
// concurrent transition to race, so no revision counter is needed. Returns whether a matching terminal
// attempt was cleared.
export async function clearStagePath(
  db: DbClient,
  input: ClearStageInput
): Promise<ClearStageResult> {
  const rows = await db
    .update(workCreationAttempts)
    .set({ stagePath: null, updatedAt: input.now })
    .where(
      and(
        eq(workCreationAttempts.id, input.id),
        eq(workCreationAttempts.userId, input.userId),
        terminalStateCondition()
      )
    )
    .returning({ id: workCreationAttempts.id });
  return Object.freeze({ cleared: rows.length > 0 });
}
