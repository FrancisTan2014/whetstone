import { z } from "zod";

import { reviewStateDtoSchema } from "./memoryContracts.js";
import {
  materialReviewCandidateDtoSchema,
  nearMaterialReviewCandidateDtoSchema
} from "./noteReviewContracts.js";
import { mcpPreviewNextActionSchema, mcpRenderedCardSchema } from "./mcpPreviewContracts.js";

// The commit half of the local-MCP card surface (#718). Where `preview_card_creation` (#717) stages an
// opaque, expiring attempt and returns the rendered card for learner approval, `commit_card_creation`
// consumes exactly that approved attempt and composes the SAME canonical direct-card (#689) / existing-Note
// (#688) writer the in-app flow uses. MCP owns transport and the audit channel only: the commit carries NO
// content — only the opaque `attemptId` and one decision — so a client can never enroll a changed payload.
// The staged draft lives on the attempt; an edit requires a fresh preview. These schemas are the whole wire
// vocabulary the tool exposes.

// The only new tool this issue adds. Named once so the server registration, the discovery assertion, and the
// retirement guard all reference a single constant.
export const COMMIT_CARD_CREATION_TOOL = "commit_card_creation";

// A generous upper bound on each opaque id so an untrusted client cannot submit an unbounded key.
export const MCP_COMMIT_ID_MAX_LENGTH = 200;

// The one decision a commit carries, mirroring the in-app material-review decisions plus the no-candidate
// create path. `create` mints a new standalone note+card (only valid when the approved preview surfaced NO
// candidate); `reuse` adds the drafted direction to one reviewed candidate Note (`noteEntryId` must be a
// candidate the preview surfaced); `keep_separate` deliberately mints a distinct note despite candidates.
// `.strict()` on every variant rejects any smuggled Question/Answer/Success check, id override, FSRS/due/
// event field, or unknown key — the transport carries only the decision, never content.
export const mcpCommitDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z
    .object({
      kind: z.literal("reuse"),
      noteEntryId: z.string().trim().min(1).max(MCP_COMMIT_ID_MAX_LENGTH)
    })
    .strict(),
  z.object({ kind: z.literal("keep_separate") }).strict()
]);

export type McpCommitDecision = z.infer<typeof mcpCommitDecisionSchema>;

// The commit input. Deliberately narrow: the opaque `attemptId` returned by a prior preview, plus one
// decision. `.strict()` rejects any content field (question/answer/successCheck), any revision or fingerprint
// override, any batch/array, user id, file path, or unknown key — a commit acts on the staged draft, never a
// resubmitted one, so there is nothing else to send.
export const mcpCommitCardInputSchema = z
  .object({
    attemptId: z.string().trim().min(1).max(MCP_COMMIT_ID_MAX_LENGTH),
    decision: mcpCommitDecisionSchema
  })
  .strict();

export type McpCommitCardInput = z.infer<typeof mcpCommitCardInputSchema>;

// The committed card the client may report back: the created/reused note id, the created prompt id, and the
// freshly seeded shared review card's FSRS state (due now, at the recall retention). No private body beyond
// the already-approved preview is returned. Reused into every success variant so a create, a reuse, and a
// keep-separate all report the same shape.
export const mcpCommittedCardSchema = z
  .object({
    noteId: z.string(),
    promptId: z.string(),
    review: reviewStateDtoSchema
  })
  .strict();

export type McpCommittedCard = z.infer<typeof mcpCommittedCardSchema>;

// A refreshed preview the client must present for approval AGAIN: the authoritative recheck under the commit
// lock found the reviewed candidate set moved (a new/changed/deleted candidate, or the near evidence policy
// shifted) since the learner approved, so the commit refreshed the attempt and forces a fresh approval rather
// than enrolling against stale evidence. It carries the same rendered card (the draft never changed) plus the
// current candidate groups, the bumped `revision`/`candidateFingerprint`, and the fixed approval gate — the
// lexical related-material is unchanged by definition (it depends only on the fixed Answer) and is not
// re-sent.
export const mcpRefreshedPreviewSchema = z
  .object({
    attemptId: z.string(),
    expiresAt: z.string(),
    approvalRequired: z.literal(true),
    nextAction: mcpPreviewNextActionSchema,
    renderedCard: mcpRenderedCardSchema,
    candidates: z.array(materialReviewCandidateDtoSchema),
    nearCandidates: z.array(nearMaterialReviewCandidateDtoSchema),
    candidateFingerprint: z.string(),
    revision: z.number().int().nonnegative()
  })
  .strict();

export type McpRefreshedPreview = z.infer<typeof mcpRefreshedPreviewSchema>;

// The discriminated commit result carried as the tool's structured content.
//
// Success: `created` (no-candidate create), `reused` (direction added to a reviewed Note), and
// `kept_separate` (distinct note despite candidates) each carry the committed card. A retry after success
// returns this SAME result untouched (receipt idempotency), so a lost response never double-enrolls.
//
// Re-approval: `needs_approval` returns the refreshed preview when the candidate evidence moved since
// approval — the learner must approve the refreshed draft again.
//
// Named failures (all with ZERO writes): `not_found` (forged, foreign, non-preview, or swept attempt),
// `expired` (a lapsed approval window), `candidates_exist` (a `create` while the reviewed set is non-empty),
// `not_a_candidate` (a `reuse` whose Note is not among the reviewed candidates), `no_material` (a
// `keep_separate` while the reviewed set is empty — nothing to be separate from), `decision_conflict` (a
// retry of an already-committed attempt with a DIFFERENT decision, including reuse of a different Note),
// `conflict` (the attempt's request id was already committed for a DIFFERENT draft — mint a fresh preview),
// and `gone` (a retry whose original card was since deleted — the receipt tombstone never resurrects it).
export const mcpCommitCardResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), card: mcpCommittedCardSchema }).strict(),
  z.object({ status: z.literal("reused"), card: mcpCommittedCardSchema }).strict(),
  z.object({ status: z.literal("kept_separate"), card: mcpCommittedCardSchema }).strict(),
  z.object({ status: z.literal("needs_approval"), preview: mcpRefreshedPreviewSchema }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z.object({ status: z.literal("candidates_exist") }).strict(),
  z.object({ status: z.literal("not_a_candidate") }).strict(),
  z.object({ status: z.literal("no_material") }).strict(),
  z.object({ status: z.literal("decision_conflict") }).strict(),
  z.object({ status: z.literal("conflict") }).strict(),
  z.object({ status: z.literal("gone") }).strict()
]);

export type McpCommitCardResult = z.infer<typeof mcpCommitCardResultSchema>;

export function parseMcpCommitCardInput(value: unknown): McpCommitCardInput {
  return mcpCommitCardInputSchema.parse(value);
}

export function parseMcpCommitCardResult(value: unknown): McpCommitCardResult {
  return mcpCommitCardResultSchema.parse(value);
}
