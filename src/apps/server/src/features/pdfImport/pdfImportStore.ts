import {
  PINNED_DOCLING_CORE_VERSION,
  PINNED_DOCLING_VERSION,
  SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS,
  type PdfImportFailureDto,
  type RangeConversion
} from "@whetstone/contracts";
import {
  isNonTerminalAttemptState,
  isRetryableAttemptState,
  mayApplyRunOutput,
  type PdfImportAttemptState,
  type PdfImportPhase,
  type WorkLanguage
} from "@whetstone/domain";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { pdfImportAttempts, pdfImportPublications, pdfImportRanges } from "../../db/schema.js";

// Durable persistence for recoverable staged PDF import attempts (#721). Every write that a live
// conversion makes is FENCED by the run token: a checkpoint, probe, heartbeat, or terminal transition is
// applied only while the row is still `running` under the same token, so a stale child (after cancel,
// restart, or interrupt) can never publish. Single admission is guaranteed by the DB partial-unique
// index on running rows plus the transactional claim here. All page progress is recomputed from the
// committed ranges, so it is exact and idempotent regardless of retries.

// The exact converter build committed ranges are produced under. A resume reuses only ranges matching
// this fingerprint and drops the rest, so an adapter-version change transparently reconverts. Kept in
// lockstep with the pinned #701 runtime (contracts).
export const PDF_IMPORT_ADAPTER_FINGERPRINT = `docling@${PINNED_DOCLING_VERSION}/core@${PINNED_DOCLING_CORE_VERSION}/schema@${SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!}`;

export type PdfImportAttemptRecord = Readonly<{
  id: string;
  userId: string;
  sourceHash: string;
  state: PdfImportAttemptState;
  runToken: string | null;
  phase: PdfImportPhase | null;
  ocrFingerprint: string | null;
  ocrLanguage: WorkLanguage;
  adapterFingerprint: string | null;
  stagePath: string | null;
  totalPages: number | null;
  completedPages: number;
  totalRanges: number | null;
  failure: PdfImportFailureDto | null;
  createdAt: Date;
  updatedAt: Date;
  heartbeatAt: Date | null;
}>;

type AttemptRow = typeof pdfImportAttempts.$inferSelect;

function toRecord(row: AttemptRow): PdfImportAttemptRecord {
  return Object.freeze({
    id: row.id,
    userId: row.userId,
    sourceHash: row.sourceHash,
    state: row.state,
    runToken: row.runToken,
    phase: row.phase,
    ocrFingerprint: row.ocrFingerprint,
    ocrLanguage: row.ocrLanguage as WorkLanguage,
    adapterFingerprint: row.adapterFingerprint,
    stagePath: row.stagePath,
    totalPages: row.totalPages,
    completedPages: row.completedPages,
    totalRanges: row.totalRanges,
    failure: row.failure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    heartbeatAt: row.heartbeatAt
  });
}

// Every fenced update carries the same `updated_at` bump; a matched row proves the write was applied.
export type Executor = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

async function sumCommittedPages(
  tx: Executor,
  attemptId: string,
  fingerprint: string
): Promise<number> {
  const rows = await tx
    .select({
      pages: sql<number>`coalesce(sum(${pdfImportRanges.endPage} - ${pdfImportRanges.startPage} + 1), 0)::int`
    })
    .from(pdfImportRanges)
    .where(
      and(eq(pdfImportRanges.attemptId, attemptId), eq(pdfImportRanges.fingerprint, fingerprint))
    );
  return rows.reduce((total, row) => total + row.pages, 0);
}

export type InsertQueuedAttemptInput = Readonly<{
  id: string;
  userId: string;
  sourceHash: string;
  stagePath: string;
  ocrLanguage: WorkLanguage;
  now: Date;
}>;

export async function insertQueuedAttempt(
  executor: Executor,
  input: InsertQueuedAttemptInput
): Promise<PdfImportAttemptRecord> {
  const [row] = await executor
    .insert(pdfImportAttempts)
    .values({
      id: input.id,
      userId: input.userId,
      sourceHash: input.sourceHash,
      state: "queued",
      stagePath: input.stagePath,
      ocrLanguage: input.ocrLanguage,
      completedPages: 0,
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
): Promise<PdfImportAttemptRecord | null> {
  const [row] = await db
    .select()
    .from(pdfImportAttempts)
    .where(and(eq(pdfImportAttempts.id, id), eq(pdfImportAttempts.userId, userId)));
  return row === undefined ? null : toRecord(row);
}

export async function getAttemptById(
  db: DbClient,
  id: string
): Promise<PdfImportAttemptRecord | null> {
  const [row] = await db.select().from(pdfImportAttempts).where(eq(pdfImportAttempts.id, id));
  return row === undefined ? null : toRecord(row);
}

export type ClaimInput = Readonly<{ runToken: string; fingerprint: string; now: Date }>;

// Atomically claim the single conversion slot for the oldest queued attempt. Returns null when the
// queue is empty OR another attempt already holds the slot (single admission). The claim is atomic by
// construction: SKIP LOCKED means two concurrent claimers can never lock the SAME queued row, and the
// row is transitioned with a compare-and-set on the still-`queued` state, so a stale claimer can never
// overwrite the winner's run token or spawn a duplicate child; the DB partial-unique index on running
// rows is the final backstop against two distinct attempts running at once. Stale committed ranges
// (from a different adapter build) are dropped and progress recomputed, so a resume never trusts an
// incompatible checkpoint.
export async function claimNextQueued(
  db: DbClient,
  input: ClaimInput
): Promise<PdfImportAttemptRecord | null> {
  return db.transaction(async (tx) => {
    // Single admission: yield while any attempt is already running. The partial-unique index on
    // `state = 'running'` is the hard database backstop; this early check keeps the common
    // already-busy path from locking a queued row it could never claim.
    const [running] = await tx
      .select({ id: pdfImportAttempts.id })
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.state, "running"))
      .limit(1);
    if (running !== undefined) {
      return null;
    }

    // Lock the oldest queued row with SKIP LOCKED so two concurrent claimers can never select the
    // SAME attempt: a competitor skips the row this transaction already holds instead of racing to
    // re-claim it. This is what stops a second caller from overwriting the winner's run token or
    // spawning a duplicate converter child for one attempt.
    const [queued] = await tx
      .select()
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.state, "queued"))
      .orderBy(asc(pdfImportAttempts.createdAt), asc(pdfImportAttempts.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (queued === undefined) {
      return null;
    }

    await tx
      .delete(pdfImportRanges)
      .where(
        and(
          eq(pdfImportRanges.attemptId, queued.id),
          ne(pdfImportRanges.fingerprint, input.fingerprint)
        )
      );
    const completedPages = await sumCommittedPages(tx, queued.id, input.fingerprint);

    // Compare-and-set on the still-`queued` state: the claim applies only while the row is still
    // claimable, so it can never resurrect an attempt another claimer already moved out of `queued`.
    const [claimed] = await tx
      .update(pdfImportAttempts)
      .set({
        state: "running",
        runToken: input.runToken,
        phase: "preflight",
        adapterFingerprint: input.fingerprint,
        completedPages,
        heartbeatAt: input.now,
        updatedAt: input.now
      })
      .where(and(eq(pdfImportAttempts.id, queued.id), eq(pdfImportAttempts.state, "queued")))
      .returning();
    /* v8 ignore next 3 -- concurrency-only: the SKIP-LOCKED row lock already prevents a rival from
       transitioning this locked row, so the compare-and-set can only miss under a true race that no
       single-threaded test can drive; the guard stays as defense-in-depth rather than a fake seam. */
    if (claimed === undefined) {
      return null;
    }
    return toRecord(claimed);
  });
}

// Fenced update guard: only touch the row while it is still `running` under `runToken`.
function fencedWhere(id: string, runToken: string) {
  return and(
    eq(pdfImportAttempts.id, id),
    eq(pdfImportAttempts.runToken, runToken),
    eq(pdfImportAttempts.state, "running")
  );
}

export type ProbeResultInput = Readonly<{
  id: string;
  runToken: string;
  totalPages: number;
  totalRanges: number;
  now: Date;
}>;

export async function setProbeResult(db: DbClient, input: ProbeResultInput): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({
      totalPages: input.totalPages,
      totalRanges: input.totalRanges,
      heartbeatAt: input.now,
      updatedAt: input.now
    })
    .where(fencedWhere(input.id, input.runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

// Record the durable phase of a running attempt (#745), fenced by the run token so a stale child can
// never move the phase of an attempt it no longer owns. Returns false when fenced. The phase is a status
// hint only: recovery never trusts it, it recomputes real work from `ocr_fingerprint` and the committed
// ranges.
export async function setPhase(
  db: DbClient,
  id: string,
  runToken: string,
  phase: PdfImportPhase,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({ phase, heartbeatAt: now, updatedAt: now })
    .where(fencedWhere(id, runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

// Atomically adopt a validated OCR stage (#745): record its fingerprint (engine build + language) and
// advance the phase to `structured`. `ocr_fingerprint` becoming non-null is the recovery boundary — from
// here a crash resumes structured conversion over the derived `ocr.pdf` without re-running OCR. Fenced by
// the run token; returns false when the child was superseded, so the runner does not proceed to convert.
export async function adoptOcrStage(
  db: DbClient,
  id: string,
  runToken: string,
  ocrFingerprint: string,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({ ocrFingerprint, phase: "structured", heartbeatAt: now, updatedAt: now })
    .where(fencedWhere(id, runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

export async function heartbeat(
  db: DbClient,
  id: string,
  runToken: string,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({ heartbeatAt: now, updatedAt: now })
    .where(fencedWhere(id, runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

export type CommitRangeInput = Readonly<{
  attemptId: string;
  runToken: string;
  rangeIndex: number;
  startPage: number;
  endPage: number;
  fingerprint: string;
  payload: RangeConversion;
  now: Date;
}>;

// Persist one validated range, idempotently by (attempt, range), and only while the claim still holds
// the slot. Returns false when fenced (the child was superseded), so the runner stops instead of
// continuing to write into a cancelled/interrupted attempt. Page progress is recomputed from the
// committed ranges, so a duplicate commit never double-counts.
export async function commitRange(db: DbClient, input: CommitRangeInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ state: pdfImportAttempts.state, runToken: pdfImportAttempts.runToken })
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.id, input.attemptId));
    if (attempt === undefined || !mayApplyRunOutput(attempt, input.runToken)) {
      return false;
    }

    await tx
      .insert(pdfImportRanges)
      .values({
        attemptId: input.attemptId,
        rangeIndex: input.rangeIndex,
        startPage: input.startPage,
        endPage: input.endPage,
        fingerprint: input.fingerprint,
        payload: input.payload
      })
      .onConflictDoNothing({
        target: [pdfImportRanges.attemptId, pdfImportRanges.rangeIndex]
      });

    const completedPages = await sumCommittedPages(tx, input.attemptId, input.fingerprint);
    await tx
      .update(pdfImportAttempts)
      .set({ completedPages, heartbeatAt: input.now, updatedAt: input.now })
      .where(fencedWhere(input.attemptId, input.runToken));
    return true;
  });
}

// The committed range indices for the current build, so a resume continues after the last one.
export async function getCommittedRangeIndices(
  db: DbClient,
  attemptId: string,
  fingerprint: string
): Promise<readonly number[]> {
  const rows = await db
    .select({ rangeIndex: pdfImportRanges.rangeIndex })
    .from(pdfImportRanges)
    .where(
      and(eq(pdfImportRanges.attemptId, attemptId), eq(pdfImportRanges.fingerprint, fingerprint))
    )
    .orderBy(asc(pdfImportRanges.rangeIndex));
  return rows.map((row) => row.rangeIndex);
}

// The number of committed ranges for an attempt, for status reporting (a count, never a percentage).
export async function countCommittedRanges(db: DbClient, attemptId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(pdfImportRanges)
    .where(eq(pdfImportRanges.attemptId, attemptId));
  return rows.reduce((total, row) => total + row.value, 0);
}

// The committed range payloads for the current build, ordered by range index, so #702's publication can
// reconstruct the full structured document from the checkpoints #721 persisted. Trusts already-validated
// payloads (each was validated by `parseRangeConversion` before it was committed).
export async function getCommittedRanges(
  db: DbClient,
  attemptId: string,
  fingerprint: string
): Promise<readonly RangeConversion[]> {
  const rows = await db
    .select({ payload: pdfImportRanges.payload })
    .from(pdfImportRanges)
    .where(
      and(eq(pdfImportRanges.attemptId, attemptId), eq(pdfImportRanges.fingerprint, fingerprint))
    )
    .orderBy(asc(pdfImportRanges.rangeIndex));
  return rows.map((row) => row.payload as RangeConversion);
}

// The #702 publication record for an attempt: the learner's capture-time intent plus, once published,
// exactly one resolved outcome (`workEntryId` for a published Work, `ocrValidationFailedPages` for a
// document still text-less after the OCR pass, `noContent` for the typed empty-document refusal, or
// `unpreservableImages` for the typed unsupported-image refusal). All null means the publication is
// still pending.
export type PdfImportPublicationRecord = Readonly<{
  attemptId: string;
  enteredTitle: string | null;
  enteredAuthor: string | null;
  enteredLanguage: string | null;
  fileName: string;
  workEntryId: string | null;
  ocrValidationFailedPages: number | null;
  noContent: boolean | null;
  unpreservableImages: number | null;
  // A warning on a successful publication (#806): unresolved figure placeholders in the published Work,
  // or null when there were none. Positive only alongside a non-null `workEntryId`.
  unresolvedFigureCount: number | null;
  publishedAt: Date | null;
}>;

type PublicationRow = typeof pdfImportPublications.$inferSelect;

function toPublicationRecord(row: PublicationRow): PdfImportPublicationRecord {
  return Object.freeze({
    attemptId: row.attemptId,
    enteredTitle: row.enteredTitle,
    enteredAuthor: row.enteredAuthor,
    enteredLanguage: row.enteredLanguage,
    fileName: row.fileName,
    workEntryId: row.workEntryId,
    ocrValidationFailedPages: row.ocrValidationFailedPages,
    noContent: row.noContent,
    unpreservableImages: row.unpreservableImages,
    unresolvedFigureCount: row.unresolvedFigureCount,
    publishedAt: row.publishedAt
  });
}

export type InsertPublicationIntentInput = Readonly<{
  attemptId: string;
  enteredTitle: string | null;
  enteredAuthor: string | null;
  enteredLanguage: string | null;
  fileName: string;
}>;

// Record the learner's upload-time intent for a freshly queued attempt, before any conversion. The
// outcome columns stay null until publication resolves them. Accepts a transaction so the intent can be
// inserted atomically with the queued-attempt row: the attempt is never claimable without its intent.
export async function insertPublicationIntent(
  executor: Executor,
  input: InsertPublicationIntentInput
): Promise<void> {
  await executor.insert(pdfImportPublications).values({
    attemptId: input.attemptId,
    enteredTitle: input.enteredTitle,
    enteredAuthor: input.enteredAuthor,
    enteredLanguage: input.enteredLanguage,
    fileName: input.fileName
  });
}

export async function getPublication(
  db: DbClient,
  attemptId: string
): Promise<PdfImportPublicationRecord | null> {
  const [row] = await db
    .select()
    .from(pdfImportPublications)
    .where(eq(pdfImportPublications.attemptId, attemptId));
  return row === undefined ? null : toPublicationRecord(row);
}

// Link a published Work to its publication as the terminal job state, inside the caller's claim
// transaction so the outcome commits atomically with the Work. Only applies while the publication is
// still pending (no result yet), so a re-run cannot relink an already-resolved publication.
// A publication is still pending only while no outcome column is set: no linked Work and none of the
// typed terminal refusals (OCR-validation-failed, no-content, unsupported-image) recorded.
function pendingPublicationCondition(): ReturnType<typeof and> {
  return and(
    sql`${pdfImportPublications.workEntryId} is null`,
    sql`${pdfImportPublications.ocrValidationFailedPages} is null`,
    sql`${pdfImportPublications.noContent} is null`,
    sql`${pdfImportPublications.unpreservableImages} is null`
  );
}

// Every terminal marker updates under this guard so a re-run can never overwrite an already-resolved
// outcome (published Work, OCR-validation-failed, no-content, or unsupported-image refusal).
function pendingPublicationGuard(attemptId: string): ReturnType<typeof and> {
  return and(eq(pdfImportPublications.attemptId, attemptId), pendingPublicationCondition());
}

export async function linkPublishedWork(
  tx: Executor,
  attemptId: string,
  workEntryId: string,
  now: Date,
  // The unresolved-figure warning count (#806) for this publication, or null when the Work carried no
  // unresolved figures. Recorded atomically with the linked Work so a successful publication always
  // exposes its figure-review workload.
  unresolvedFigureCount: number | null = null
): Promise<void> {
  await tx
    .update(pdfImportPublications)
    .set({
      workEntryId,
      publishedAt: now,
      unresolvedFigureCount: unresolvedFigureCount === 0 ? null : unresolvedFigureCount
    })
    .where(pendingPublicationGuard(attemptId));
}

// Record the typed OCR-validation-failed outcome (no Work) for a pending publication: a document still
// had text-less pages after the OCR pass (a preflight/full-conversion disagreement or incomplete OCR),
// so publishing is refused rather than dropping content.
export async function markPublicationOcrValidationFailed(
  db: DbClient,
  attemptId: string,
  pages: number,
  now: Date
): Promise<void> {
  await db
    .update(pdfImportPublications)
    .set({ ocrValidationFailedPages: pages, publishedAt: now })
    .where(pendingPublicationGuard(attemptId));
}

// Record the typed no-content refusal (no Work) for a pending publication: the pages carried native text
// but mapped to zero canonical blocks, so publishing would create an empty-shell Work.
export async function markPublicationNoContent(
  db: DbClient,
  attemptId: string,
  now: Date
): Promise<void> {
  await db
    .update(pdfImportPublications)
    .set({ noContent: true, publishedAt: now })
    .where(pendingPublicationGuard(attemptId));
}

// Record the typed unsupported-image refusal (no Work) for a pending publication: the document contains
// picture/figure constructs whose images #701 cannot extract, so publishing would lose content.
export async function markPublicationImagesUnsupported(
  db: DbClient,
  attemptId: string,
  unpreservableImages: number,
  now: Date
): Promise<void> {
  await db
    .update(pdfImportPublications)
    .set({ unpreservableImages, publishedAt: now })
    .where(pendingPublicationGuard(attemptId));
}

// The runner's post-conversion transition (#750): every structured range passed validation, so the
// attempt is parked as `awaiting_review` (NOT `converted`/published). The stage and committed ranges are
// retained; publication happens only later, under a serialized Work-creation review decision. Fenced by
// the run token so a superseded (cancelled/interrupted) claim cannot flip a stale attempt to review.
export async function markAwaitingReview(
  db: DbClient,
  id: string,
  runToken: string,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({
      state: "awaiting_review",
      runToken: null,
      phase: "publication",
      heartbeatAt: null,
      updatedAt: now
    })
    .where(fencedWhere(id, runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

// The publication transition (#750): an `awaiting_review` attempt whose review decision published (or
// refused) its source moves to the terminal `converted` state, so no further review attempt is ever
// minted for it and the source is done. Fenced on the `awaiting_review` state (the run token is already
// null by this point), so it is idempotent — a re-run after the outcome already committed is a no-op.
// Returns whether the transition applied.
export async function markReviewPublished(db: DbClient, id: string, now: Date): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({ state: "converted", updatedAt: now })
    .where(and(eq(pdfImportAttempts.id, id), eq(pdfImportAttempts.state, "awaiting_review")))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

export async function markFailed(
  db: DbClient,
  id: string,
  runToken: string,
  failure: PdfImportFailureDto,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({
      state: "failed",
      failure,
      runToken: null,
      heartbeatAt: null,
      updatedAt: now
    })
    .where(fencedWhere(id, runToken))
    .returning({ id: pdfImportAttempts.id });
  return applied.length > 0;
}

// Clear the stage binding ONLY after the staged bytes were actually removed from disk. Terminal and
// cancel transitions keep `stagePath` set until the filesystem removal succeeds, so a failed cleanup
// leaves the attempt `bound` (visible in status and retryable) instead of forgetting the path and
// orphaning the bytes. Scoped by id: the attempt is already terminal/cancelled and the caller has
// owner-checked it.
export async function clearStagePath(db: DbClient, id: string, now: Date): Promise<void> {
  await db
    .update(pdfImportAttempts)
    .set({ stagePath: null, updatedAt: now })
    .where(eq(pdfImportAttempts.id, id));
}

export type CancelResult = Readonly<{
  cancelled: boolean;
  wasRunning: boolean;
  stagePath: string | null;
}>;

// The states an owner may cancel are exactly the non-terminal ones (`queued`, `running`, `interrupted`),
// decided by the domain state machine rather than a duplicated set here. Clearing the run token AND
// leaving `running` fences any late child output. `stagePath` is intentionally kept until the caller
// removes the staged bytes (then clears it via `clearStagePath`), so a failed cleanup stays retryable.
// Returns whether a child must be terminated and the stage to remove.
export async function markCancelled(
  db: DbClient,
  userId: string,
  id: string,
  now: Date
): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(pdfImportAttempts)
      .where(and(eq(pdfImportAttempts.id, id), eq(pdfImportAttempts.userId, userId)));
    if (attempt === undefined || !isNonTerminalAttemptState(attempt.state)) {
      return { cancelled: false, wasRunning: false, stagePath: null };
    }
    await tx
      .update(pdfImportAttempts)
      .set({
        state: "cancelled",
        runToken: null,
        heartbeatAt: null,
        updatedAt: now
      })
      .where(eq(pdfImportAttempts.id, id));
    return {
      cancelled: true,
      wasRunning: attempt.state === "running",
      stagePath: attempt.stagePath
    };
  });
}

// Startup recovery: a `running` attempt whose owning process died is marked `interrupted` (never left
// running, never silently resumed). Its stage and committed ranges are untouched, so a retry can resume.
export async function recoverInterruptedAttempts(db: DbClient, now: Date): Promise<number> {
  const recovered = await db
    .update(pdfImportAttempts)
    .set({ state: "interrupted", runToken: null, heartbeatAt: null, updatedAt: now })
    .where(eq(pdfImportAttempts.state, "running"))
    .returning({ id: pdfImportAttempts.id });
  return recovered.length;
}

// Retry: promote an attempt back to `queued` so the runner resumes it after the last committed range.
// Only an `interrupted` attempt is retryable (decided by the domain state machine); its committed
// ranges, stage, and probe totals are kept. Owner-scoped and rejected (returns false) for any other
// state, rather than a silent no-op.
export async function retryInterrupted(
  db: DbClient,
  userId: string,
  id: string,
  now: Date
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ state: pdfImportAttempts.state })
      .from(pdfImportAttempts)
      .where(and(eq(pdfImportAttempts.id, id), eq(pdfImportAttempts.userId, userId)));
    if (attempt === undefined || !isRetryableAttemptState(attempt.state)) {
      return false;
    }
    await tx
      .update(pdfImportAttempts)
      .set({ state: "queued", runToken: null, updatedAt: now })
      .where(eq(pdfImportAttempts.id, id));
    return true;
  });
}
