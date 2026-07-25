import type {
  MaterialReviewCandidateDto,
  NearMaterialReviewCandidateDto
} from "@whetstone/contracts";
import { BlankNoteMaterialError } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import { findNearMatchNotes } from "../notes/noteNearMatchQuery.js";
import { findExactMaterialNotes } from "../notes/noteQueries.js";
import {
  loadMaterialReviewCandidates,
  loadNearMaterialReviewCandidates
} from "./materialReviewCandidates.js";

// Both advisory candidate groups the New-card composer warns over BEFORE save (#712, #714): exact material
// already in Notes, and high-precision "Possible duplicate" near matches. The groups are DISJOINT by
// construction — the near matcher excludes anything exactly equal — so a note never appears in both.
export type MaterialMatches = Readonly<{
  candidates: MaterialReviewCandidateDto[];
  nearCandidates: NearMaterialReviewCandidateDto[];
}>;

// The advisory material query (#712, #714): the New-card composer debounces this over the drafted Answer to
// warn "This material is already in Notes" or surface a "Possible duplicate" BEFORE the learner saves. It is
// strictly READ-ONLY and never authoritative — the save always reprojects and rechecks both matchers under
// the advisory lock, so a stale, missed, or raced hint can never change what is created. A draft whose Answer
// projects to nothing (still empty, or only whitespace) has no material to match, so exact resolves to an
// empty list rather than an error; an Answer that is a single word, non-ASCII, or structurally unsupported
// yields no near candidates. The hint simply stays silent until the draft carries comparable content.
export async function queryMaterialMatches(
  db: DbClient,
  userId: string,
  answerDoc: unknown
): Promise<MaterialMatches> {
  let exact;
  try {
    exact = await findExactMaterialNotes(db, { bodyDoc: answerDoc, userId });
  } catch (error) {
    if (error instanceof BlankNoteMaterialError) {
      return { candidates: [], nearCandidates: [] };
    }
    throw error;
  }
  const near = await findNearMatchNotes(db, { bodyDoc: answerDoc, userId });
  const [candidates, nearCandidates] = await Promise.all([
    loadMaterialReviewCandidates(db, userId, exact),
    loadNearMaterialReviewCandidates(db, userId, answerDoc, near)
  ]);
  return { candidates, nearCandidates };
}
