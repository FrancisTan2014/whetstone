import type { MaterialReviewCandidateDto } from "@whetstone/contracts";
import { BlankNoteMaterialError } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import { findExactMaterialNotes } from "../notes/noteQueries.js";
import { loadMaterialReviewCandidates } from "./materialReviewCandidates.js";

// The advisory exact-material query (#712): the New-card composer debounces this over the drafted Answer to
// warn "This material is already in Notes" BEFORE the learner saves. It is strictly READ-ONLY and never
// authoritative — the save always reprojects and rechecks under the advisory lock, so a stale, missed, or
// raced hint can never change what is created. A draft whose Answer projects to nothing (still empty, or
// only whitespace) has no material to match, so it resolves to an empty list rather than an error — the
// hint simply stays silent until the draft carries real content.
export async function queryExactMaterial(
  db: DbClient,
  userId: string,
  answerDoc: unknown
): Promise<MaterialReviewCandidateDto[]> {
  let matches;
  try {
    matches = await findExactMaterialNotes(db, { bodyDoc: answerDoc, userId });
  } catch (error) {
    if (error instanceof BlankNoteMaterialError) {
      return [];
    }
    throw error;
  }
  return loadMaterialReviewCandidates(db, userId, matches);
}
