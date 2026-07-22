import { toAuthorId, toEntryId, type EntryId } from "@whetstone/domain";
import type { WorkContentDto, WorkDto } from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { uploadedSourceClaims, workMeta } from "../../db/schema.js";
import { loadWorkContent } from "./contentQueries.js";
import { assertContentPersisted } from "./insertBatching.js";

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// The Work an uploaded-source hash resolves to, with its content — the payload a reopen returns.
export type ClaimedWork = Readonly<{ work: WorkDto; content: WorkContentDto }>;

// The one create-or-reopen result every uploaded format shares (#706), so #702's canonical PDF import
// consumes the same boundary: `exact_existing` reopened the Work that already owns these bytes,
// `created` minted a new Work whose source + claim were written atomically.
export type ClaimOutcome =
  | Readonly<{ status: "exact_existing"; work: WorkDto; content: WorkContentDto }>
  | Readonly<{ status: "created"; work: WorkDto; content: WorkContentDto }>;

// What a format's `commit` returns after writing its Work/source/blocks inside the claim transaction:
// the created Work, its id (the claim's owner), and how many blocks it should have persisted so the
// boundary can assert the write landed.
export type ClaimCommit = Readonly<{
  work: WorkDto;
  workEntryId: EntryId;
  expectedBlockCount: number;
}>;

// Resolve the Work that already owns these exact uploaded bytes, or undefined when the hash is
// unclaimed. The claim is the single source of identity: one row per hash, joined to its Work.
export async function findClaimedWork(
  db: DbClient,
  sha256: string
): Promise<ClaimedWork | undefined> {
  const rows = await db
    .select({
      authorId: workMeta.authorId,
      entryId: workMeta.entryId,
      language: workMeta.language,
      origin: workMeta.origin,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(uploadedSourceClaims)
    .innerJoin(workMeta, eq(workMeta.entryId, uploadedSourceClaims.workEntryId))
    .where(eq(uploadedSourceClaims.sha256, sha256))
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

  return { work, content: await loadWorkContent(db, workEntryId) };
}

// Insert the single-owner claim inside the caller's Work/source transaction. The sha256 primary key
// makes it race-safe: a concurrent loser's insert throws a unique violation, rolling the whole
// transaction back so no duplicate Work is published.
export async function insertSourceClaim(
  tx: Transaction,
  sha256: string,
  workEntryId: EntryId
): Promise<void> {
  await tx.insert(uploadedSourceClaims).values({ sha256, workEntryId });
}

// A PostgreSQL unique-violation (SQLSTATE 23505) is how the claim boundary recognizes the concurrent
// loser without matching brittle message text. Drizzle wraps the driver error, so the pg `code` may sit
// on a wrapped `cause` rather than the top-level error — walk the cause chain to find it.
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") {
      return true;
    }

    if (!("cause" in current)) {
      return false;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

// The shared create-or-reopen boundary for uploaded bytes (#706). Identical bytes resolve idempotently
// to one Work; a new upload writes its Work + source + claim in a single transaction. `stage` performs
// the pre-transaction side effects (writing the retained source file) and returns a handle; `commit`
// writes the rows inside the claim transaction; `releaseStage` removes the staged file if the upload
// turns out to be a duplicate or the transaction fails, so a reopen never orphans a file.
export async function claimUploadedSource<Stage>(
  db: DbClient,
  params: Readonly<{
    sha256: string;
    stage: () => Promise<Stage>;
    commit: (tx: Transaction, staged: Stage) => Promise<ClaimCommit>;
    releaseStage: (staged: Stage) => Promise<void>;
  }>
): Promise<ClaimOutcome> {
  const existing = await findClaimedWork(db, params.sha256);

  if (existing !== undefined) {
    // The bytes are already claimed, so nothing is staged — the reopen removes no file.
    return { status: "exact_existing", content: existing.content, work: existing.work };
  }

  const staged = await params.stage();
  let built: ClaimCommit;

  try {
    built = await db.transaction(async (tx) => {
      const result = await params.commit(tx, staged);
      await insertSourceClaim(tx, params.sha256, result.workEntryId);

      return result;
    });
  } catch (error) {
    // Either a concurrent winner claimed the hash first, or the write failed: either way the staged
    // file must not leak. On the concurrency loss, reopen the winner the transaction rolled back for.
    await params.releaseStage(staged);

    if (isUniqueViolation(error)) {
      const winner = await findClaimedWork(db, params.sha256);

      if (winner !== undefined) {
        return { status: "exact_existing", content: winner.content, work: winner.work };
      }
    }

    throw error;
  }

  const content = assertContentPersisted(
    built.expectedBlockCount,
    await loadWorkContent(db, built.workEntryId)
  );

  return { status: "created", content, work: built.work };
}
