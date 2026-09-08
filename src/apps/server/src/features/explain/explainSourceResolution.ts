import type { EntryId } from "@whetstone/domain";
import { buildSelectionContext, normalizeHeadword } from "@whetstone/domain";
import type { ExplainLanguage } from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { workMeta } from "../../db/schema.js";
import { findBlockInWork } from "../notes/noteQueries.js";

// Canonical source resolution for the semantic-map explanation capability (#924). Reuses the exact
// block-ownership boundary note anchors already rely on (`findBlockInWork`, #312) instead of trusting
// any client-supplied context: a block is only ever addressed by its own Work id, over both the legacy
// and PM substrates, and a soft-deleted block never resolves. `workMeta.language`/`contentRevision` are
// read directly here (a one-query, two-column read, not worth a shared query for one caller) so the
// prompt's language profile and the cache's invalidation key both come from the canonical Work row,
// never from client input.

export type ExplainSelectionRequest = Readonly<{
  blockEntryId: EntryId;
  endOffset: number;
  selectedText: string;
  startOffset: number;
  workEntryId: EntryId;
}>;

export type ResolvedExplainSource = Readonly<{
  // The Work's own content-revision fence (#703): part of the cache key, so any canonical edit to the
  // Work's blocks invalidates every cached answer for it, even one whose selection still happens to
  // slice out the same characters by coincidence.
  contentRevision: number;
  context: string;
  headword: string;
  language: ExplainLanguage;
}>;

export type ExplainSourceOutcome =
  | Readonly<{ status: "ok"; source: ResolvedExplainSource }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "stale_selection" }>;

// A Work's own `language` column is `zh-CN` | `zh-TW` | `en`; the explanation only needs to pick between
// an English and a (modern) Chinese linguistic profile, never a client-supplied value.
function toExplainLanguage(workLanguage: string): ExplainLanguage {
  return workLanguage.startsWith("zh") ? "zh" : "en";
}

type WorkMetaRow = Readonly<{ contentRevision: number; language: string }>;

async function loadWorkMeta(db: DbClient, workEntryId: EntryId): Promise<WorkMetaRow | undefined> {
  const rows = await db
    .select({ contentRevision: workMeta.contentRevision, language: workMeta.language })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId))
    .limit(1);
  return rows[0];
}

// Resolve and validate the canonical selection: the block must belong to the named Work (never
// soft-deleted), and the client's own `selectedText`/offset snapshot must still match the block's
// current plaintext EXACTLY (over the same UTF-16 code-unit offsets note anchors use) — any mismatch
// means the source changed underneath the learner, so this returns `stale_selection` rather than
// silently explaining a different span or substituting an unrelated passage.
export async function resolveExplainSource(
  db: DbClient,
  request: ExplainSelectionRequest
): Promise<ExplainSourceOutcome> {
  const [block, work] = await Promise.all([
    findBlockInWork(db, request.workEntryId, request.blockEntryId),
    loadWorkMeta(db, request.workEntryId)
  ]);

  if (block === undefined || work === undefined) {
    return { status: "not_found" };
  }

  if (request.endOffset > block.plaintext.length) {
    return { status: "stale_selection" };
  }

  const actualSelectedText = block.plaintext.slice(request.startOffset, request.endOffset);
  if (actualSelectedText !== request.selectedText) {
    return { status: "stale_selection" };
  }

  const headword = normalizeHeadword(actualSelectedText);

  return {
    status: "ok",
    source: {
      contentRevision: work.contentRevision,
      context: buildSelectionContext(block.plaintext, request.startOffset, request.endOffset),
      headword,
      language: toExplainLanguage(work.language)
    }
  };
}
