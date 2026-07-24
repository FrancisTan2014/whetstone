import {
  decomposeMarkdown,
  toAuthorId,
  toEntryId,
  fingerprintReviewedCandidates
} from "@whetstone/domain";
import type {
  ImportMarkdownWorkRequest,
  IngestEpubResultDto,
  WorkCreationReviewDto,
  WorkDto
} from "@whetstone/contracts";
import { and, eq, ne } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { workMeta } from "../../db/schema.js";
import type { WorkDuplicateCandidateLog } from "../library/workDuplicateCandidatesQueries.js";
import {
  commitImportedMarkdownWork,
  type ContentDependencies
} from "../content/contentCommands.js";
import { commitImportedEpubWork, parseEpubBytes } from "../content/epubCommands.js";
import { loadWorkContent } from "../content/contentQueries.js";
import { findClaimedWork, isUniqueViolation } from "../content/sourceClaims.js";
import {
  buildReviewDto,
  computeReviewCandidates,
  proposedFromAttempt,
  resolveProposedAuthor
} from "./markdownDuplicateReview.js";
import {
  beginFinalizeAttempt,
  cancelAttempt,
  clearStagePath,
  completeAttempt,
  detachStagePath,
  expireAttempts,
  getActiveAttemptForUser,
  getAttempt,
  insertPendingAttempt,
  updateAttemptReview,
  type ProposedMetadataInput,
  type WorkCreationAttemptRecord
} from "./workCreationAttemptStore.js";

// The server-owned Markdown creation-review boundary (#747). Imported-Markdown Work creation is routed
// through a durable review attempt (#725) built on the #724 candidate policy: the browser holds only an
// opaque attempt id + revision and sends a semantic decision, so it can neither create around review nor
// decide candidate policy. Exact uploaded bytes always reopen the owning Work; a credible candidate always
// parks a decision; and a decision commits or discards the staged upload exactly once, revision-fenced.

// Everything the orchestration needs: the shared content dependencies (db, source file store, id
// generators) it reuses to commit a Work, plus the attempt id/stage id generators, the clock, and the
// attempt TTL. Deriving db/store from `content` keeps a single wiring point.
export type WorkCreationDependencies = Readonly<{
  content: ContentDependencies;
  createAttemptId: () => string;
  createStageId: () => string;
  now: () => Date;
  attemptTtlMs: number;
  log: WorkDuplicateCandidateLog;
}>;

export type BeginResult =
  | Readonly<{ status: "created" | "exact_existing"; result: IngestEpubResultDto }>
  | Readonly<{ status: "needs_review"; review: WorkCreationReviewDto }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "author_not_found" }>
  | Readonly<{ status: "uncertain" }>;

// The EPUB creation begin outcomes (#748). EPUB has no learner-typed author selection (metadata is
// embedded) and no "empty content" refusal (the atomic writer accepts whatever the spine yields), so it
// replaces those with `invalid_epub` for bytes the parser could not open. Exact-reopen, immediate-create,
// needs-review, and uncertain match the Markdown boundary exactly, so the review API/UI never forks.
export type BeginEpubResult =
  | Readonly<{ status: "created" | "exact_existing"; result: IngestEpubResultDto }>
  | Readonly<{ status: "needs_review"; review: WorkCreationReviewDto }>
  | Readonly<{ status: "invalid_epub" }>
  | Readonly<{ status: "uncertain" }>;

export type ReviewResult =
  | Readonly<{ status: "ok"; review: WorkCreationReviewDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "expired" }>
  | Readonly<{ status: "uncertain" }>;

export type DecisionResult =
  | Readonly<{ status: "opened" | "created" | "exact_existing"; result: IngestEpubResultDto }>
  | Readonly<{ status: "needs_review"; review: WorkCreationReviewDto }>
  | Readonly<{ status: "existing_gone" | "expired" | "superseded" | "uncertain" | "not_found" }>;

export type BackResult = Readonly<{ cancelled: boolean }>;

function db(deps: WorkCreationDependencies): DbClient {
  return deps.content.db;
}

// Sweep every attempt past its TTL to `expired` and remove each one's staged bytes, then confirm the
// clear. Called opportunistically at the start of each operation so an abandoned attempt never blocks the
// owner's single-active-attempt slot and a stale review reports `expired` instead of live candidates. No
// stage is ever removed by age alone — only the exact paths the sweep returns.
async function sweepExpired(deps: WorkCreationDependencies, nowDate: Date): Promise<void> {
  const expired = await expireAttempts(db(deps), nowDate);

  for (const attempt of expired) {
    if (attempt.stagePath !== null) {
      await deps.content.sourceFileStore.deleteSourceFile(attempt.stagePath);
    }

    await clearStagePath(db(deps), { userId: attempt.userId, id: attempt.id, now: nowDate });
  }
}

// A Work reopened by id: its metadata plus decomposed content, in the same shape an exact-source reopen
// returns. Authored Works are excluded so a decision can never reopen the learner's own Writing as if it
// were an import duplicate; a missing/authored id resolves to undefined so the caller reports `existing_gone`.
async function loadReopenableWork(
  database: DbClient,
  entryId: string
): Promise<IngestEpubResultDto | undefined> {
  const rows = await database
    .select({
      authorId: workMeta.authorId,
      entryId: workMeta.entryId,
      language: workMeta.language,
      origin: workMeta.origin,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workMeta)
    .where(and(eq(workMeta.entryId, entryId), ne(workMeta.origin, "authored")))
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return undefined;
  }

  const workEntryId = toEntryId(row.entryId);
  const work: WorkDto = {
    authorId: toAuthorId(row.authorId),
    entryId: workEntryId,
    language: row.language,
    origin: row.origin,
    title: row.title,
    workType: row.workType
  };

  return { content: await loadWorkContent(database, workEntryId), work };
}

// The proposal, in the store's persisted shape (author name carried even for a brand-new author).
function proposedMetadata(
  request: ImportMarkdownWorkRequest,
  authorId: string | null,
  authorName: string
): ProposedMetadataInput {
  return {
    title: request.title,
    authorId,
    authorName,
    language: request.language,
    workType: request.workType
  };
}

// Refresh an attempt's PERSISTED review to the current duplicate evidence before returning it, so the
// candidates and the revision fence the client will decide against are exactly what the server holds. When
// the evidence changed since the attempt was parked, persist the new snapshot under a bumped revision (the
// same fenced update the keep-separate refresh path uses) and return the review at that revision; otherwise
// the persisted view is already current. This closes the gap where GET/resume could display a candidate the
// decision would then reject as `existing_gone` (Open existing) or force a redundant re-review (Keep
// separate returning `needs_review`) because the shown evidence was never persisted or revision-bumped.
// Throws on a candidate-query failure so the caller maps it to `uncertain`.
async function refreshPersistedReview(
  deps: WorkCreationDependencies,
  attempt: WorkCreationAttemptRecord,
  nowDate: Date
): Promise<WorkCreationReviewDto> {
  const review = await computeReviewCandidates(db(deps), deps.log, proposedFromAttempt(attempt));

  if (fingerprintReviewedCandidates(review.snapshot) === attempt.candidateFingerprint) {
    return buildReviewDto(attempt, review);
  }

  const updated = await updateAttemptReview(db(deps), {
    userId: attempt.userId,
    id: attempt.id,
    expectedRevision: attempt.revision,
    proposed: {
      title: attempt.proposedTitle,
      authorId: attempt.proposedAuthorId,
      authorName: attempt.proposedAuthorName,
      language: attempt.proposedLanguage,
      workType: attempt.proposedWorkType
    },
    candidates: review.snapshot,
    now: nowDate
  });

  /* v8 ignore next 3 -- the attempt was just read as pending at this revision, so the fenced update can only
     miss under a concurrent decision no single-threaded test can drive; the recomputed view is then returned
     against the loaded revision and the decision path re-fences it. */
  if (updated === null) {
    return buildReviewDto(attempt, review);
  }

  return buildReviewDto(updated, review);
}

// Begin an imported-Markdown creation. Exact uploaded bytes reopen the owning Work; empty content and an
// unknown existing author are refused before anything is staged; with no credible candidate the Work is
// committed immediately; with a credible candidate exactly one review attempt is persisted (staged bytes +
// snapshot) and the review is returned. A candidate-query or parse failure yields `uncertain`, never a
// false "no duplicates".
export async function beginMarkdownCreation(
  deps: WorkCreationDependencies,
  userId: string,
  request: ImportMarkdownWorkRequest
): Promise<BeginResult> {
  const nowDate = deps.now();
  await sweepExpired(deps, nowDate);

  const author = await resolveProposedAuthor(db(deps), request.author);

  if (!author.found) {
    return { status: "author_not_found" };
  }

  // Parse up front so empty content is refused before any candidate work or staging; a parse failure is
  // uncertainty, not empty content.
  let blockCount: number;

  try {
    blockCount = decomposeMarkdown(request.markdown).flatMap((unit) => unit.blocks).length;
  } catch {
    /* v8 ignore next -- decomposeMarkdown is a pure parser over a validated non-empty string and does not
       throw for string input; the catch is defense-in-depth so a future parser change degrades to uncertain
       (retry) rather than a false "no duplicates". */
    return { status: "uncertain" };
  }

  if (blockCount === 0) {
    return { status: "empty_content" };
  }

  const sha256 = deps.content.sourceFileStore.hashMarkdown(request.markdown);
  const existing = await findClaimedWork(db(deps), sha256);

  if (existing !== undefined) {
    return { status: "exact_existing", result: existing };
  }

  let review;

  try {
    review = await computeReviewCandidates(db(deps), deps.log, {
      title: request.title,
      authorId: author.authorId,
      language: request.language,
      workType: request.workType
    });
  } catch {
    return { status: "uncertain" };
  }

  if (review.candidates.length === 0) {
    const outcome = await commitImportedMarkdownWork(deps.content, {
      author: request.author,
      fileName: request.fileName,
      language: request.language,
      markdown: request.markdown,
      title: request.title,
      workType: request.workType
    });

    /* v8 ignore next -- the no-candidate commit returns `created`; `exact_existing` only under a claim race
       after the identity recheck above, which no single-threaded test can drive. */
    if (outcome.status === "created" || outcome.status === "exact_existing") {
      return { status: outcome.status, result: outcome.result };
    }

    /* v8 ignore next 2 -- empty content and the existing author were validated above, so the immediate
       commit can only return created/exact_existing here; the guard stays as defense-in-depth. */
    return outcome.status === "empty_content"
      ? { status: "empty_content" }
      : { status: "author_not_found" };
  }

  // Stage the uploaded bytes and persist ONE pending attempt with the reviewed snapshot. A concurrent
  // active attempt for this owner loses the single-active-attempt index: discard the just-staged file and
  // resume the existing review instead of orphaning bytes or double-owning the slot.
  const stageId = deps.createStageId();
  const written = await deps.content.sourceFileStore.writeMarkdownSource({
    id: stageId,
    markdown: request.markdown
  });

  try {
    const attempt = await insertPendingAttempt(db(deps), {
      id: deps.createAttemptId(),
      userId,
      proposed: proposedMetadata(request, author.authorId, author.authorName),
      sourceKind: "markdown",
      sourceHash: sha256,
      sourceFileName: request.fileName,
      candidates: review.snapshot,
      stagePath: written.path,
      expiresAt: new Date(nowDate.getTime() + deps.attemptTtlMs),
      now: nowDate
    });

    return { status: "needs_review", review: buildReviewDto(attempt, review) };
  } catch (error) {
    await deps.content.sourceFileStore.deleteSourceFile(written.path);

    /* v8 ignore next -- a non-unique-violation insert failure is unexpected infrastructure error; the
       false branch falls through to the rethrow below. */
    if (isUniqueViolation(error)) {
      const active = await getActiveAttemptForUser(db(deps), userId);

      /* v8 ignore next -- a unique violation always leaves a resumable active attempt; the non-pending
         fallthrough guards a begin racing a concurrent decision mid-finalize (rethrown below). */
      if (active !== null && active.state === "pending") {
        return {
          status: "needs_review",
          review: await refreshPersistedReview(deps, active, nowDate)
        };
      }
    }

    /* v8 ignore next -- a non-unique insert failure is an unexpected infrastructure error; surface it. */
    throw error;
  }
}

// Begin an imported-EPUB creation (#748). Mirrors the Markdown boundary: exact uploaded bytes reopen the
// owning Work; bytes the parser cannot open are `invalid_epub`; with no credible candidate the Work is
// committed immediately through the atomic EPUB writer; with a credible candidate exactly one review
// attempt is persisted (staged EPUB bytes + snapshot) and the review is returned. Metadata is embedded
// (OPF), so the author is resolved from the embedded name against the canonical identity WITHOUT creating
// one — an unmatched name is kept as proposed evidence and minted only in the final Work transaction. A
// candidate-query failure yields `uncertain`, never a false "no duplicates".
export async function beginEpubCreation(
  deps: WorkCreationDependencies,
  userId: string,
  bytes: Uint8Array
): Promise<BeginEpubResult> {
  const nowDate = deps.now();
  await sweepExpired(deps, nowDate);

  const sha256 = deps.content.sourceFileStore.hashBytes(bytes);

  // Exact uploaded bytes reopen the owning Work before any parse/candidate work — identical bytes resolve
  // to the one owning Work regardless of format, so a re-upload only ever shows Open existing.
  const existing = await findClaimedWork(db(deps), sha256);

  if (existing !== undefined) {
    return { status: "exact_existing", result: existing };
  }

  // Parse up front for the embedded metadata (no image storage, no content write yet) so an unopenable
  // upload is refused and the candidate check runs on real title/author/language.
  const parsed = await parseEpubBytes(deps.content, bytes);

  if (parsed.status === "invalid_epub") {
    return { status: "invalid_epub" };
  }

  const metadata = parsed.parsed.metadata;
  // Resolve the embedded author against the SAME canonical identity every author is stored under, so a
  // name-equivalent existing author corroborates a same-author duplicate; a genuinely new name resolves to
  // a null id and is created only inside the final Work transaction.
  const author = await resolveProposedAuthor(db(deps), { mode: "new", name: metadata.author });

  /* v8 ignore next 2 -- a `new` author selection always resolves to found:true; the guard only narrows the
     union and degrades a future resolver change to a retryable uncertain rather than a crash. */
  if (!author.found) {
    return { status: "uncertain" };
  }

  let review;

  try {
    review = await computeReviewCandidates(db(deps), deps.log, {
      title: metadata.title,
      authorId: author.authorId,
      language: metadata.language,
      workType: "book"
    });
  } catch {
    return { status: "uncertain" };
  }

  if (review.candidates.length === 0) {
    const outcome = await commitImportedEpubWork(deps.content, { bytes, parsed: parsed.parsed });

    return { status: outcome.status, result: outcome.result };
  }

  // Stage the uploaded EPUB bytes and persist ONE pending attempt with the reviewed snapshot. A concurrent
  // active attempt for this owner loses the single-active-attempt index: discard the just-staged file and
  // resume the existing review instead of orphaning bytes or double-owning the slot.
  const stageId = deps.createStageId();
  const written = await deps.content.sourceFileStore.writeEpubSource({ bytes, id: stageId });

  try {
    const attempt = await insertPendingAttempt(db(deps), {
      id: deps.createAttemptId(),
      userId,
      proposed: {
        title: metadata.title,
        authorId: author.authorId,
        authorName: author.authorName,
        language: metadata.language,
        workType: "book"
      },
      sourceKind: "epub",
      sourceHash: sha256,
      // EPUB uploads carry no filename in v0; the review panel derives a `<title>.epub` label instead.
      sourceFileName: null,
      candidates: review.snapshot,
      stagePath: written.path,
      expiresAt: new Date(nowDate.getTime() + deps.attemptTtlMs),
      now: nowDate
    });

    return { status: "needs_review", review: buildReviewDto(attempt, review) };
  } catch (error) {
    await deps.content.sourceFileStore.deleteSourceFile(written.path);

    /* v8 ignore next -- a non-unique-violation insert failure is unexpected infrastructure error; the
       false branch falls through to the rethrow below. */
    if (isUniqueViolation(error)) {
      const active = await getActiveAttemptForUser(db(deps), userId);

      /* v8 ignore next -- a unique violation always leaves a resumable active attempt; the non-pending
         fallthrough guards a begin racing a concurrent decision mid-finalize (rethrown below). */
      if (active !== null && active.state === "pending") {
        return {
          status: "needs_review",
          review: await refreshPersistedReview(deps, active, nowDate)
        };
      }
    }

    /* v8 ignore next -- a non-unique insert failure is an unexpected infrastructure error; surface it. */
    throw error;
  }
}

// Load an attempt's current review for its owner, refreshing candidates (persisting the refreshed snapshot
// under a bumped revision when the evidence changed, so the shown candidates and revision are exactly what a
// later decision accepts) and expiry. A missing or non-pending attempt is `not_found` (or `expired` once
// swept); a candidate-query failure is `uncertain`.
export async function getWorkCreationReview(
  deps: WorkCreationDependencies,
  userId: string,
  attemptId: string
): Promise<ReviewResult> {
  const nowDate = deps.now();
  await sweepExpired(deps, nowDate);

  const attempt = await getAttempt(db(deps), userId, attemptId);

  if (attempt === null) {
    return { status: "not_found" };
  }

  if (attempt.state === "expired") {
    return { status: "expired" };
  }

  if (attempt.state !== "pending") {
    return { status: "not_found" };
  }

  try {
    return { status: "ok", review: await refreshPersistedReview(deps, attempt, nowDate) };
  } catch {
    return { status: "uncertain" };
  }
}

// Guard shared by both decisions: resolve the attempt and reject a stale/gone one before any state change.
// Returns the live pending attempt at the expected revision, or a terminal decision outcome to return.
type AttemptGuard =
  | Readonly<{ ok: true; attempt: WorkCreationAttemptRecord }>
  | Readonly<{ ok: false; result: DecisionResult }>;

async function guardPendingAttempt(
  deps: WorkCreationDependencies,
  userId: string,
  attemptId: string,
  revision: number,
  nowDate: Date
): Promise<AttemptGuard> {
  await sweepExpired(deps, nowDate);

  const attempt = await getAttempt(db(deps), userId, attemptId);

  if (attempt === null) {
    return { ok: false, result: { status: "not_found" } };
  }

  if (attempt.state === "expired") {
    return { ok: false, result: { status: "expired" } };
  }

  // A stale revision, an already-finalizing decision, or a terminal attempt are all fenced out as
  // superseded — a replayed or racing decision is rejected, never reapplied.
  if (attempt.state !== "pending" || attempt.revision !== revision) {
    return { ok: false, result: { status: "superseded" } };
  }

  return { ok: true, attempt };
}

// Discard the staged bytes of a just-completed attempt: remove the file, then confirm the clear. The
// attempt is already terminal, so this is leftover cleanup, not a live-decision transfer.
async function discardStage(
  deps: WorkCreationDependencies,
  userId: string,
  attempt: WorkCreationAttemptRecord,
  nowDate: Date
): Promise<void> {
  /* v8 ignore next -- a markdown attempt always carries a stage path into discard; the guard is defensive. */
  if (attempt.stagePath !== null) {
    await deps.content.sourceFileStore.deleteSourceFile(attempt.stagePath);
  }

  await clearStagePath(db(deps), { userId, id: attempt.id, now: nowDate });
}

// Open existing: reopen a reviewed candidate Work and consume the attempt without creating anything. The
// chosen Work's existence is rechecked BEFORE the decision is fenced, so a vanished candidate reports
// `existing_gone` while leaving the attempt live for another choice.
export async function openExistingWork(
  deps: WorkCreationDependencies,
  userId: string,
  attemptId: string,
  revision: number,
  entryId: string
): Promise<DecisionResult> {
  const nowDate = deps.now();
  const guard = await guardPendingAttempt(deps, userId, attemptId, revision, nowDate);

  if (!guard.ok) {
    return guard.result;
  }

  // Fence Open existing to the server-reviewed candidate set (#747): the client may only choose one of the
  // Works the review actually surfaced as a possible duplicate, never an arbitrary existing id. An id absent
  // from the attempt's persisted snapshot is rejected WITHOUT consuming the attempt or discarding the staged
  // upload, so a client can neither decide candidate policy nor reopen an unreviewed Work around the review.
  // The existence/ownership recheck below still applies to a reviewed id.
  /* v8 ignore next -- a pending review attempt always carries its reviewed snapshot; the ?? only guards types. */
  const reviewedSnapshot = guard.attempt.candidateSnapshot ?? [];

  if (!reviewedSnapshot.some((entry) => entry.entryId === entryId)) {
    return { status: "existing_gone" };
  }

  const reopened = await loadReopenableWork(db(deps), entryId);

  if (reopened === undefined) {
    return { status: "existing_gone" };
  }

  const fenced = await beginFinalizeAttempt(db(deps), {
    userId,
    id: attemptId,
    expectedRevision: revision,
    now: nowDate
  });

  /* v8 ignore next -- the pending revision was just verified under the guard; the fence can only miss
     under a concurrent decision no single-threaded test can drive. */
  if (fenced === null) {
    return { status: "superseded" };
  }

  const completed = await completeAttempt(db(deps), {
    userId,
    id: attemptId,
    expectedRevision: fenced.revision,
    now: nowDate
  });

  /* v8 ignore next -- completion follows the begin-finalize at its bumped revision, so it cannot miss
     single-threaded; the guard stays as defense-in-depth. */
  if (completed === null) {
    return { status: "superseded" };
  }

  await discardStage(deps, userId, guard.attempt, nowDate);

  return { status: "opened", result: reopened };
}

// Keep separate: confirm the proposal is a distinct Work. Exact bytes claimed meanwhile reopen the owner
// (`exact_existing`); changed evidence refreshes the panel (`needs_review`); otherwise the Work is
// committed, transferring the staged upload to provenance exactly once.
export async function keepSeparateWork(
  deps: WorkCreationDependencies,
  userId: string,
  attemptId: string,
  revision: number
): Promise<DecisionResult> {
  const nowDate = deps.now();
  const guard = await guardPendingAttempt(deps, userId, attemptId, revision, nowDate);

  if (!guard.ok) {
    return guard.result;
  }

  const attempt = guard.attempt;
  // An uploaded creation attempt (Markdown or EPUB) always carries its uploaded hash and stage; assert
  // for the type narrowing.
  const sha256 = attempt.sourceHash;

  /* v8 ignore next -- an uploaded creation attempt always records its uploaded hash; guard for types. */
  if (sha256 === null) {
    return { status: "uncertain" };
  }

  const existing = await findClaimedWork(db(deps), sha256);

  if (existing !== undefined) {
    const fenced = await beginFinalizeAttempt(db(deps), {
      userId,
      id: attemptId,
      expectedRevision: revision,
      now: nowDate
    });

    /* v8 ignore next -- guarded pending revision; fence can only miss under an untestable concurrent race. */
    if (fenced === null) {
      return { status: "superseded" };
    }

    const completed = await completeAttempt(db(deps), {
      userId,
      id: attemptId,
      expectedRevision: fenced.revision,
      now: nowDate
    });

    /* v8 ignore next -- completion follows begin-finalize at its bumped revision; cannot miss single-threaded. */
    if (completed === null) {
      return { status: "superseded" };
    }

    await discardStage(deps, userId, attempt, nowDate);

    return { status: "exact_existing", result: existing };
  }

  let review;

  try {
    review = await computeReviewCandidates(db(deps), deps.log, proposedFromAttempt(attempt));
  } catch {
    return { status: "uncertain" };
  }

  // The reviewed evidence changed since the learner approved it: refresh the panel under the same revision
  // fence and force a fresh confirmation instead of committing against stale evidence.
  if (fingerprintReviewedCandidates(review.snapshot) !== attempt.candidateFingerprint) {
    const updated = await updateAttemptReview(db(deps), {
      userId,
      id: attemptId,
      expectedRevision: revision,
      proposed: {
        title: attempt.proposedTitle,
        authorId: attempt.proposedAuthorId,
        authorName: attempt.proposedAuthorName,
        language: attempt.proposedLanguage,
        workType: attempt.proposedWorkType
      },
      candidates: review.snapshot,
      now: nowDate
    });

    /* v8 ignore next -- guarded pending revision; the update can only miss under an untestable concurrent race. */
    if (updated === null) {
      return { status: "superseded" };
    }

    return { status: "needs_review", review: buildReviewDto(updated, review) };
  }

  // Evidence unchanged: claim the decision slot, transfer the staged bytes to provenance, and commit the
  // Work exactly once.
  const fenced = await beginFinalizeAttempt(db(deps), {
    userId,
    id: attemptId,
    expectedRevision: revision,
    now: nowDate
  });

  /* v8 ignore next -- guarded pending revision; fence can only miss under an untestable concurrent race. */
  if (fenced === null) {
    return { status: "superseded" };
  }

  const detached = await detachStagePath(db(deps), {
    userId,
    id: attemptId,
    expectedRevision: fenced.revision,
    now: nowDate
  });

  /* v8 ignore next -- the fenced attempt holds the slot with an ordinary upload stage, so the detach cannot
     miss single-threaded; the guard stays as defense-in-depth. */
  if (detached === null) {
    return { status: "uncertain" };
  }

  const outcome = await commitReviewedUpload(deps, attempt, detached.stagePath);

  const completed = await completeAttempt(db(deps), {
    userId,
    id: attemptId,
    expectedRevision: detached.revision,
    now: nowDate
  });

  /* v8 ignore next -- completion follows the detach at its bumped revision; cannot miss single-threaded. */
  if (completed === null) {
    return { status: "superseded" };
  }

  if (outcome.status === "created" || outcome.status === "exact_existing") {
    return { status: outcome.status, result: outcome.result };
  }

  /* v8 ignore next 2 -- the proposal was validated at begin and its bytes were unclaimed above, so the
     transfer commit can only return created/exact_existing here. */
  return { status: "uncertain" };
}

// Commit a reviewed attempt's staged upload to a Work, transferring the staged file to provenance in place
// (never re-writing or double-owning it). Dispatches by the attempt's source kind: an EPUB stage is
// re-parsed from its exact staged bytes and committed through the atomic EPUB writer (units, canonical
// blocks, authored nav, images — all in one transaction); a Markdown stage is read as text and committed
// through the shared Markdown writer. The upstream fence guarantees the attempt owns exactly one ordinary
// upload stage, so no other kind reaches here.
async function commitReviewedUpload(
  deps: WorkCreationDependencies,
  attempt: WorkCreationAttemptRecord,
  stagePath: string
): Promise<
  | Readonly<{ status: "created" | "exact_existing"; result: IngestEpubResultDto }>
  | Readonly<{ status: "uncertain" }>
> {
  if (attempt.sourceKind === "epub") {
    const bytes = await deps.content.sourceFileStore.readEpubSource(stagePath);
    const parsed = await parseEpubBytes(deps.content, bytes);

    /* v8 ignore next 3 -- the staged bytes parsed successfully at begin, so re-parsing the identical file
       cannot fail single-threaded; degrade to uncertain rather than commit half a Work. */
    if (parsed.status === "invalid_epub") {
      return { status: "uncertain" };
    }

    return commitImportedEpubWork(deps.content, {
      bytes,
      parsed: parsed.parsed,
      stagedSource: { path: stagePath }
    });
  }

  const markdown = await deps.content.sourceFileStore.readMarkdownSource(stagePath);
  const selection: ImportMarkdownWorkRequest["author"] =
    attempt.proposedAuthorId === null
      ? { mode: "new", name: attempt.proposedAuthorName }
      : { mode: "existing", authorId: toAuthorId(attempt.proposedAuthorId) };
  /* v8 ignore next -- a markdown attempt always records its upload fileName; the fallback is defensive. */
  const fileName = attempt.sourceFileName ?? `${attempt.proposedTitle}.md`;

  const outcome = await commitImportedMarkdownWork(deps.content, {
    author: selection,
    fileName,
    language: attempt.proposedLanguage as ImportMarkdownWorkRequest["language"],
    markdown,
    title: attempt.proposedTitle,
    workType: attempt.proposedWorkType as ImportMarkdownWorkRequest["workType"],
    stagedSource: { path: stagePath }
  });

  /* v8 ignore next -- the unclaimed transfer commit returns `created`; `exact_existing` only under a claim
     race between the identity recheck and this commit, which no single-threaded test can drive. */
  if (outcome.status === "created" || outcome.status === "exact_existing") {
    return { status: outcome.status, result: outcome.result };
  }

  /* v8 ignore next 2 -- the proposal was validated at begin and its bytes were unclaimed above, so the
     transfer commit can only return created/exact_existing here. */
  return { status: "uncertain" };
}

// Back: abandon the review, cancelling the attempt and removing its staged bytes. The author is created
// only inside a final commit, so a cancelled attempt leaves no orphan identity.
export async function cancelWorkCreation(
  deps: WorkCreationDependencies,
  userId: string,
  attemptId: string
): Promise<BackResult> {
  const nowDate = deps.now();
  const cancelled = await cancelAttempt(db(deps), userId, attemptId, nowDate);

  if (cancelled.cancelled && cancelled.stagePath !== null) {
    await deps.content.sourceFileStore.deleteSourceFile(cancelled.stagePath);
    await clearStagePath(db(deps), { userId, id: attemptId, now: nowDate });
  }

  return { cancelled: cancelled.cancelled };
}
