import type { EntryId } from "@whetstone/domain";
import { MAX_WORK_CONTENT_REVISION } from "@whetstone/contracts";
import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { workMeta } from "../../db/schema.js";

// The origin-neutral Work content-revision fence (#703). Content concurrency belongs to the Work, not to
// personal ownership or chronology: a save/correction to an editable Work's canonical blocks claims the
// Work's `content_revision` here, whatever the Work's origin. This boundary decides NOTHING about origin,
// ownership, or authorization — the calling command has already authorized the write and owns the
// surrounding transaction. It is deliberately reusable by an imported-Work correction command (#762),
// including for an imported Work that carries no `personal_entries` facet at all.

// Either the DB client or an open transaction; the boundary writes through whichever the caller owns, so
// the origin-specific command keeps atomicity and the fence stays a pure compare-and-set.
type RevisionExecutor = Pick<DbClient, "update">;

// Compare-and-set the Work's content revision: increment it by one ONLY when the stored value still equals
// the `expectedRevision` the caller loaded, and return the new revision; return `undefined` when nothing
// was claimed — a stale revision (another writer already advanced it), a missing Work, or an out-of-range
// token. Folding the check and the bump into one conditional `UPDATE ... WHERE content_revision = expected`
// closes the lost-update window a separate read-then-write leaves open: two writers that loaded the same
// revision both pass a plain read, but only one wins this UPDATE — the loser's predicate re-evaluates
// against the winner's committed row and matches zero rows. The new revision is strictly greater, so every
// successful claim is monotonic and a stale replay of an old token can never overwrite a newer write.
export async function claimWorkContentRevision(
  executor: RevisionExecutor,
  workEntryId: EntryId,
  expectedRevision: number
): Promise<number | undefined> {
  // A non-integer, negative, or above-`integer`-range token can never equal a stored `content_revision`
  // (a non-negative signed 32-bit counter), so it is definitionally stale: refuse it without touching the
  // row rather than letting a malformed or out-of-range SQL comparison surprise a caller — an out-of-range
  // value would otherwise overflow the `integer` column and raise a database error instead of a clean
  // conflict. (The manual API also rejects it at the Zod boundary; this keeps the fence safe for any
  // caller, including the imported-Work correction command #762 that does not pass through that schema.)
  if (
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > MAX_WORK_CONTENT_REVISION
  ) {
    return undefined;
  }

  const claimed = await executor
    .update(workMeta)
    .set({ contentRevision: sql`${workMeta.contentRevision} + 1` })
    .where(and(eq(workMeta.entryId, workEntryId), eq(workMeta.contentRevision, expectedRevision)))
    .returning({ contentRevision: workMeta.contentRevision });

  return claimed[0]?.contentRevision;
}
