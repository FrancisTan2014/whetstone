import {
  fingerprintReviewedCandidates,
  toAuthorId,
  type AuthorId,
  type ReviewedCandidateSnapshot,
  type WorkLanguage,
  type WorkOrigin,
  type WorkType
} from "@whetstone/domain";
import type {
  ImportMarkdownWorkRequest,
  WorkCreationReviewDto,
  WorkDuplicateCandidateReviewDto
} from "@whetstone/contracts";
import { inArray, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, workMeta } from "../../db/schema.js";
import {
  findWorkDuplicateCandidates,
  type ProposedWorkMetadataInput,
  type WorkDuplicateCandidateLog
} from "../library/workDuplicateCandidatesQueries.js";
import type { WorkCreationAttemptRecord } from "./workCreationAttemptStore.js";

// The metadata under review, in the shape the #724 candidate query consumes. `authorId` is null when the
// learner typed a brand-new author name that matches no existing Library identity, so it can never be the
// same author as any stored Work.
export type ProposedReviewMetadata = ProposedWorkMetadataInput;

// The result of resolving the learner's author selection into a scoring identity and a display name.
// `not_found` means an existing-author selection referenced an id that no longer exists, so creation is
// refused before anything is staged. A brand-new name that matches no existing author resolves to a null
// `authorId` (created only inside the final Work transaction).
export type ResolvedProposedAuthor =
  | Readonly<{ found: true; authorId: AuthorId | null; authorName: string }>
  | Readonly<{ found: false }>;

// Resolve the proposed author WITHOUT creating one: an existing selection is validated (and its canonical
// name read back for display); a brand-new name is matched against the canonical author identity so a
// name-equivalent existing author still corroborates a same-author duplicate, and only a genuinely new
// name resolves to a null identity.
export async function resolveProposedAuthor(
  db: DbClient,
  selection: ImportMarkdownWorkRequest["author"]
): Promise<ResolvedProposedAuthor> {
  if (selection.mode === "existing") {
    const rows = await db
      .select({ id: authors.id, name: authors.name })
      .from(authors)
      .where(inArray(authors.id, [selection.authorId]))
      .limit(1);
    const row = rows[0];

    if (row === undefined) {
      return { found: false };
    }

    return { found: true, authorId: toAuthorId(row.id), authorName: row.name };
  }

  const matched = await db.execute(
    // Match the typed name against the SAME canonical key every author is stored under, so a
    // canonical-equivalent existing author is reused instead of fuzzily re-created.
    sql`SELECT id FROM authors WHERE name_key = author_name_key(${selection.name}) LIMIT 1`
  );
  const matchedRow = matched.rows[0] as { id: string } | undefined;

  return {
    found: true,
    authorId: matchedRow === undefined ? null : toAuthorId(matchedRow.id),
    authorName: selection.name
  };
}

// The reviewed candidates with their factual evidence AND origin, plus the snapshot the attempt persists
// so a later decision can detect changed evidence. Every candidate is a real, non-authored Work row, so
// its origin is always present.
export type ComputedReview = Readonly<{
  candidates: ReadonlyArray<WorkDuplicateCandidateReviewDto>;
  snapshot: ReviewedCandidateSnapshot;
}>;

// Load the origin of each candidate Work so the review view can show whether a possible duplicate is an
// imported upload or a manually curated Work. Bounded to the at-most-five candidate ids.
async function loadOriginByEntryId(
  db: DbClient,
  entryIds: ReadonlyArray<string>
): Promise<ReadonlyMap<string, WorkOrigin>> {
  if (entryIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({ entryId: workMeta.entryId, origin: workMeta.origin })
    .from(workMeta)
    .where(inArray(workMeta.entryId, [...entryIds]));

  return new Map(rows.map((row) => [row.entryId, row.origin]));
}

// Recompute the #724 duplicate candidates for the proposed metadata and enrich each with its origin, then
// build both the display rows and the snapshot the attempt fingerprints. Pure scoring stays in the domain;
// this only assembles the review-shaped view. Throws propagate so the caller maps them to `uncertain`
// rather than presenting a false "no duplicates".
export async function computeReviewCandidates(
  db: DbClient,
  log: WorkDuplicateCandidateLog,
  proposed: ProposedReviewMetadata
): Promise<ComputedReview> {
  const result = await findWorkDuplicateCandidates(db, log, proposed);
  const originByEntryId = await loadOriginByEntryId(
    db,
    result.candidates.map((candidate) => candidate.entryId)
  );

  const candidates = result.candidates.map<WorkDuplicateCandidateReviewDto>((candidate) => ({
    author: { id: candidate.author.id, name: candidate.author.name },
    entryId: candidate.entryId,
    evidence: {
      editionMarkerDifferences: [...candidate.evidence.editionMarkerDifferences],
      languageDiffers: candidate.evidence.languageDiffers,
      sameAuthor: candidate.evidence.sameAuthor,
      titleSimilarity: candidate.evidence.titleSimilarity,
      workTypeDiffers: candidate.evidence.workTypeDiffers
    },
    language: candidate.language,
    matchTier: candidate.matchTier,
    // Every candidate is a real non-authored Work row, so its origin is always present here; the fallback is
    // defense-in-depth for a candidate deleted between the #724 scoring query and this origin read.
    /* v8 ignore next -- the `?? "imported"` fallback is unreachable while the candidate row exists. */
    origin: originByEntryId.get(candidate.entryId) ?? "imported",
    title: candidate.title,
    workType: candidate.workType
  }));

  const snapshot: ReviewedCandidateSnapshot = result.candidates.map((candidate) => ({
    entryId: candidate.entryId,
    title: candidate.title,
    authorId: candidate.author.id,
    authorName: candidate.author.name,
    language: candidate.language,
    workType: candidate.workType
  }));

  return { candidates, snapshot };
}

// The proposed metadata stored on an attempt, in the shape the candidate query and the review view consume.
export function proposedFromAttempt(attempt: WorkCreationAttemptRecord): ProposedReviewMetadata {
  return {
    title: attempt.proposedTitle,
    authorId: attempt.proposedAuthorId === null ? null : toAuthorId(attempt.proposedAuthorId),
    language: attempt.proposedLanguage as WorkLanguage,
    workType: attempt.proposedWorkType as WorkType
  };
}

// Assemble the owner-scoped review view the client renders: the opaque attempt id + its revision fence,
// the learner's proposal, the reviewed candidates, and a fingerprint of the evidence so the client can
// tell it changed since it loaded.
export function buildReviewDto(
  attempt: WorkCreationAttemptRecord,
  review: ComputedReview
): WorkCreationReviewDto {
  return {
    attemptId: attempt.id,
    candidateFingerprint: fingerprintReviewedCandidates(review.snapshot),
    candidates: [...review.candidates],
    proposed: {
      authorName: attempt.proposedAuthorName,
      language: attempt.proposedLanguage as WorkLanguage,
      title: attempt.proposedTitle,
      workType: attempt.proposedWorkType as WorkType
    },
    revision: attempt.revision,
    // THIS attempt's own upload name, so the panel is always framed by the reviewed attempt — never by
    // whatever file the client last posted. On a resumed single-active-attempt race this is the older
    // attempt's filename, so the two uploads cannot be conflated. EPUB uploads carry no filename in v0
    // (#748), so a stable `<title>.epub` fallback is derived from the attempt's source kind.
    /* v8 ignore next -- a markdown attempt always records its upload fileName; the fallback covers epub
       (no v0 filename) and defends a missing markdown name. */
    sourceFileName:
      attempt.sourceFileName ??
      `${attempt.proposedTitle}.${attempt.sourceKind === "epub" ? "epub" : "md"}`
  };
}
