import { isEmptyBlockChangeSet, type BlockChangeSet, type EntryId } from "@whetstone/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { docBlocks, workMeta } from "../../db/schema.js";

// The imported-Work correction markers (#762). A correction save reconciles the same canonical blocks the
// manual editor does, but it additionally records DURABLE correction evidence so a future replace/
// re-ingestion path can refuse to overwrite a Work a human has hand-corrected. This boundary owns ONLY the
// marker writes over an already-computed change set; the calling correction command owns authorization, the
// revision claim, the block reconciliation, and the surrounding transaction. It decides nothing about
// origin or ownership, and it is never called by the manual editor (manual Works are owner-authored, not
// corrections of shared imported content).

// Either the DB client or an open transaction; the boundary writes through whichever the caller owns.
type MarkerExecutor = Pick<DbClient, "update">;

// Stamp the two correction markers for the given change set, in the caller's transaction:
//
// - `work_meta.manual_corrections_at` is set to `now` on the FIRST real change only — the update is guarded
//   by `manual_corrections_at IS NULL`, so it records the earliest correction instant and is never moved by
//   a later edit (monotonic first-change evidence).
// - `doc_blocks.corrected_at` is set to `now` on every block the change set reports as inserted or content-
//   changed. A block that was only reordered keeps whatever `corrected_at` it already had, so a marker is
//   never cleared.
//
// A no-op save (an empty change set) makes no real change: it may have advanced the Work revision, but it
// stamps NEITHER marker, so an unchanged Save never fabricates false correction evidence. Returns whether a
// real change was recorded, so the caller can log or assert it.
export async function stampCorrectionMarkers(
  executor: MarkerExecutor,
  workEntryId: EntryId,
  changeSet: BlockChangeSet,
  now: Date
): Promise<boolean> {
  if (isEmptyBlockChangeSet(changeSet)) {
    return false;
  }

  await executor
    .update(workMeta)
    .set({ manualCorrectionsAt: now })
    .where(and(eq(workMeta.entryId, workEntryId), isNull(workMeta.manualCorrectionsAt)));

  const markedBlockIds = [...changeSet.inserted, ...changeSet.changed];
  if (markedBlockIds.length > 0) {
    await executor
      .update(docBlocks)
      .set({ correctedAt: now })
      .where(inArray(docBlocks.id, markedBlockIds));
  }

  return true;
}
