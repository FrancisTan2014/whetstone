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
  type PdfImportAttemptState
} from "@whetstone/domain";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { pdfImportAttempts, pdfImportRanges } from "../../db/schema.js";

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
type Executor = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

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
  now: Date;
}>;

export async function insertQueuedAttempt(
  db: DbClient,
  input: InsertQueuedAttemptInput
): Promise<PdfImportAttemptRecord> {
  const [row] = await db
    .insert(pdfImportAttempts)
    .values({
      id: input.id,
      userId: input.userId,
      sourceHash: input.sourceHash,
      state: "queued",
      stagePath: input.stagePath,
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
// queue is empty OR another attempt already holds the slot (single admission). Stale committed ranges
// (from a different adapter build) are dropped and progress recomputed, so a resume never trusts an
// incompatible checkpoint.
export async function claimNextQueued(
  db: DbClient,
  input: ClaimInput
): Promise<PdfImportAttemptRecord | null> {
  return db.transaction(async (tx) => {
    const [running] = await tx
      .select({ id: pdfImportAttempts.id })
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.state, "running"))
      .limit(1);
    if (running !== undefined) {
      return null;
    }

    const [queued] = await tx
      .select()
      .from(pdfImportAttempts)
      .where(eq(pdfImportAttempts.state, "queued"))
      .orderBy(asc(pdfImportAttempts.createdAt), asc(pdfImportAttempts.id))
      .limit(1);
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

    const [claimed] = await tx
      .update(pdfImportAttempts)
      .set({
        state: "running",
        runToken: input.runToken,
        adapterFingerprint: input.fingerprint,
        completedPages,
        heartbeatAt: input.now,
        updatedAt: input.now
      })
      .where(eq(pdfImportAttempts.id, queued.id))
      .returning();
    return toRecord(claimed!);
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

export async function markConverted(
  db: DbClient,
  id: string,
  runToken: string,
  now: Date
): Promise<boolean> {
  const applied = await db
    .update(pdfImportAttempts)
    .set({ state: "converted", runToken: null, heartbeatAt: null, updatedAt: now })
    .where(fencedWhere(id, runToken))
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
