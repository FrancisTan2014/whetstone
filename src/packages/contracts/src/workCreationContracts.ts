import { z } from "zod";

import { workCreationAttemptStates, workCreationSourceKinds } from "@whetstone/domain";

import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

// The narrow, owner-scoped contract for the durable Work CREATION-REVIEW attempt (#725). An attempt holds
// the learner's proposed metadata, the reviewed duplicate-candidate evidence they were shown, and — as
// presence only — whether it still owns an ordinary upload stage. It never carries a Work, a source claim,
// learning content, or a server filesystem path. These are the shapes the create/load/review/decision
// exchanges validate at the server boundary; the server validates once here, then trusts the typed data
// inward.
//
// The state and source-kind literals are sourced from `domain` so the DB enum, the pure state machine, and
// these DTOs can never drift apart.
export const workCreationAttemptStateSchema = z.enum(workCreationAttemptStates);

export type WorkCreationAttemptStateDto = z.infer<typeof workCreationAttemptStateSchema>;

export const workCreationSourceKindSchema = z.enum(workCreationSourceKinds);

export type WorkCreationSourceKindDto = z.infer<typeof workCreationSourceKindSchema>;

// The learner's proposed Work metadata under review. `authorId` is present only when an existing Library
// author was chosen (an exact identity reuse); a brand-new author is carried by `authorName` alone until
// the decision creates it. `title`/`authorName` are non-empty; language and type are the closed Work
// vocabularies. This proposal creates nothing — it is the input a duplicate review is computed against.
export const proposedWorkMetadataSchema = z
  .object({
    authorId: z.string().min(1).nullable().default(null),
    authorName: z.string().min(1),
    language: workLanguageDtoSchema,
    title: z.string().min(1),
    workType: workTypeDtoSchema
  })
  .strict();

export type ProposedWorkMetadataDto = z.infer<typeof proposedWorkMetadataSchema>;

// One reviewed duplicate candidate the learner was shown, captured as EVIDENCE. It mirrors the domain
// snapshot entry exactly (identity + displayed metadata), so a change to any field — not only a new
// candidate id — re-fingerprints the reviewed set and forces a fresh review before a decision commits. It
// deliberately holds no similarity score, no filesystem path, and no content.
export const reviewedCandidateSchema = z
  .object({
    authorId: z.string().min(1),
    authorName: z.string().min(1),
    entryId: z.string().min(1),
    language: workLanguageDtoSchema,
    title: z.string().min(1),
    workType: workTypeDtoSchema
  })
  .strict();

export type ReviewedCandidateDto = z.infer<typeof reviewedCandidateSchema>;

export const reviewedCandidateSnapshotSchema = z.array(reviewedCandidateSchema);

export type ReviewedCandidateSnapshotDto = z.infer<typeof reviewedCandidateSnapshotSchema>;

// The attempt's owned ordinary upload stage, reported as PRESENCE only — never a server filesystem path.
// `bound` is true while the attempt still owns staged bytes (created and bound, not yet transferred to
// provenance or removed by decision/cancel/expiry).
export const workCreationStageDtoSchema = z.object({ bound: z.boolean() }).strict();

export type WorkCreationStageDto = z.infer<typeof workCreationStageDtoSchema>;

// The loadable view of one creation-review attempt. `revision` is the compare-and-set fence the client
// echoes on its decision so a stale client cannot commit; `candidateFingerprint` lets the client detect
// that the reviewed evidence changed since it loaded. `stage` is presence only, so no server path ever
// crosses the boundary. `sourceHash`, when present, is the 64-hex sha256 of the uploaded bytes (absent for
// a metadata-only manual proposal).
export const workCreationAttemptDtoSchema = z
  .object({
    attemptId: z.string().min(1),
    candidateFingerprint: z.string().nullable(),
    candidates: reviewedCandidateSnapshotSchema,
    createdAt: z.string(),
    expiresAt: z.string(),
    proposed: proposedWorkMetadataSchema,
    revision: z.number().int().nonnegative(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "sourceHash must be 64 lowercase hex characters.")
      .nullable(),
    sourceKind: workCreationSourceKindSchema,
    stage: workCreationStageDtoSchema,
    state: workCreationAttemptStateSchema,
    updatedAt: z.string()
  })
  .strict();

export type WorkCreationAttemptDto = z.infer<typeof workCreationAttemptDtoSchema>;

export function parseProposedWorkMetadataDto(value: unknown): ProposedWorkMetadataDto {
  return proposedWorkMetadataSchema.parse(value);
}

export function parseWorkCreationAttemptDto(value: unknown): WorkCreationAttemptDto {
  return workCreationAttemptDtoSchema.parse(value);
}
