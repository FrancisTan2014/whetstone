import { workOrigins } from "@whetstone/domain";
import { z } from "zod";

import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

// The shared, owner-scoped contract surface for reviewing a possible duplicate Work BEFORE creation
// (#747). The server performs exact-source and metadata review; the browser holds only an opaque
// attempt id + revision and sends a semantic decision, so it can neither create around the review
// boundary nor decide candidate policy. This module exports the smallest surface the later format
// adapters (EPUB/manual/PDF) reuse: the review view the server renders, the two decision requests, and
// the closed vocabularies of begin/decision outcomes. Markdown parsing and stage semantics stay local
// to the server feature. Every candidate row is FACTUAL evidence — a title score, same-author flag, and
// language/type/edition differences — never a "duplicate" verdict; the learner decides.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

const nonBlankString = z.string().refine(isNonBlank, { message: "Value must be non-empty." });

// Why a candidate qualified, strongest to weakest. Mirrors the domain `WorkDuplicateMatchTier` so the
// review view can only carry a tier the scoring boundary actually assigns.
export const workDuplicateMatchTierSchema = z.enum([
  "exact",
  "same_author_fuzzy",
  "cross_author_fuzzy"
]);

export type WorkDuplicateMatchTierDto = z.infer<typeof workDuplicateMatchTierSchema>;

// A candidate's origin, surfaced as factual context (an imported upload vs. a learner-curated manual
// Work). Authored Works are never candidates, but the enum stays the full closed set so it can never
// drift from the domain vocabulary.
export const workOriginDtoSchema = z.enum(workOrigins);

// The factual reasons a candidate is surfaced. No field is a verdict: `titleSimilarity` is a score,
// `sameAuthor` is corroboration, and the difference flags/markers explain WHY two similar rows differ.
export const duplicateCandidateEvidenceDtoSchema = z
  .object({
    editionMarkerDifferences: z.array(z.string()),
    languageDiffers: z.boolean(),
    sameAuthor: z.boolean(),
    titleSimilarity: z.number(),
    workTypeDiffers: z.boolean()
  })
  .strict();

export type DuplicateCandidateEvidenceDto = z.infer<typeof duplicateCandidateEvidenceDtoSchema>;

// One reviewed candidate row: the existing Work's full identity (title, author, language, type, origin)
// plus its factual evidence. Deliberately never carries a "duplicate" boolean — the panel presents facts
// and the learner chooses Open existing or Keep separate.
export const workDuplicateCandidateReviewDtoSchema = z
  .object({
    author: z.object({ id: nonBlankString, name: nonBlankString }).strict(),
    entryId: nonBlankString,
    evidence: duplicateCandidateEvidenceDtoSchema,
    language: workLanguageDtoSchema,
    matchTier: workDuplicateMatchTierSchema,
    origin: workOriginDtoSchema,
    title: nonBlankString,
    workType: workTypeDtoSchema
  })
  .strict();

export type WorkDuplicateCandidateReviewDto = z.infer<typeof workDuplicateCandidateReviewDtoSchema>;

// The learner's own proposal as shown back to them in review. Carries the proposed author NAME only
// (never an id): a brand-new author has no identity yet, and the panel shows what the learner typed.
export const workCreationProposalViewDtoSchema = z
  .object({
    authorName: nonBlankString,
    language: workLanguageDtoSchema,
    title: nonBlankString,
    workType: workTypeDtoSchema
  })
  .strict();

export type WorkCreationProposalViewDto = z.infer<typeof workCreationProposalViewDtoSchema>;

// The full owner-scoped review view: the opaque attempt id and its revision fence (echoed on a
// decision), the learner's proposal, and the reviewed candidates. `candidateFingerprint` lets a client
// notice the reviewed evidence changed since it loaded. It carries no Work content and no server path.
export const workCreationReviewDtoSchema = z
  .object({
    attemptId: nonBlankString,
    candidateFingerprint: z.string(),
    candidates: z.array(workDuplicateCandidateReviewDtoSchema),
    proposed: workCreationProposalViewDtoSchema,
    revision: z.number().int().nonnegative()
  })
  .strict();

export type WorkCreationReviewDto = z.infer<typeof workCreationReviewDtoSchema>;

export function parseWorkCreationReviewDto(value: unknown): WorkCreationReviewDto {
  return workCreationReviewDtoSchema.parse(value);
}

// The closed vocabulary of BEGIN outcomes (POST the uploaded Markdown). `exact_existing` reopened the
// Work that already owns these exact bytes; `created` committed immediately (no credible candidate);
// `needs_review` persisted one attempt and returned the review; `empty_content` refused unsupported
// input; `uncertain` means the candidate query could not be trusted, so nothing was created and the
// client must retry rather than be shown a false "no duplicates".
export const workCreationBeginOutcomes = [
  "exact_existing",
  "created",
  "needs_review",
  "empty_content",
  "uncertain"
] as const;

export type WorkCreationBeginOutcome = (typeof workCreationBeginOutcomes)[number];

// The closed vocabulary of DECISION outcomes (Open existing / Keep separate). `opened` reopened the
// chosen existing Work (no Work changed); `created` committed a new Work; `needs_review` refreshed the
// panel because the candidate evidence changed; `exact_existing` means the same bytes were meanwhile
// claimed; `existing_gone` means the chosen Work no longer exists; `expired` means the attempt outlived
// its TTL; `superseded` means a stale revision / concurrent finalization / replay was fenced out;
// `uncertain` means a recheck could not be trusted (never offers Keep separate as if no evidence
// existed); `not_found` means no such attempt for this owner.
export const workCreationDecisionOutcomes = [
  "opened",
  "created",
  "needs_review",
  "exact_existing",
  "existing_gone",
  "expired",
  "superseded",
  "uncertain",
  "not_found"
] as const;

export type WorkCreationDecisionOutcome = (typeof workCreationDecisionOutcomes)[number];

// Open existing: the learner picked one reviewed candidate to reopen. `entryId` must be a candidate the
// review showed; `revision` fences the decision against a stale client. The server rechecks the Work's
// existence/ownership before reopening and changes no Work.
export const openExistingDecisionRequestSchema = z
  .object({
    entryId: nonBlankString,
    revision: z.number().int().nonnegative()
  })
  .strict();

export type OpenExistingDecisionRequest = z.infer<typeof openExistingDecisionRequestSchema>;

export function parseOpenExistingDecisionRequest(value: unknown): OpenExistingDecisionRequest {
  return openExistingDecisionRequestSchema.parse(value);
}

// Keep separate: the learner confirmed their proposal is a distinct Work. `revision` fences the
// decision; the server rechecks exact identity and #724 candidates before committing.
export const keepSeparateDecisionRequestSchema = z
  .object({
    revision: z.number().int().nonnegative()
  })
  .strict();

export type KeepSeparateDecisionRequest = z.infer<typeof keepSeparateDecisionRequestSchema>;

export function parseKeepSeparateDecisionRequest(value: unknown): KeepSeparateDecisionRequest {
  return keepSeparateDecisionRequestSchema.parse(value);
}
