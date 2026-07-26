import { z } from "zod";

import {
  materialReviewCandidateDtoSchema,
  nearMaterialReviewCandidateDtoSchema
} from "./noteReviewContracts.js";
import {
  relatedMaterialRelationsResponseSchema,
  relatedMaterialSenseRefSchema,
  relatedMaterialSensesResponseSchema
} from "./relatedMaterialContracts.js";

// The single local-MCP surface for preview (#717). MCP is a thin transport into the SAME shared card
// validation/matching a New card runs — never a second content boundary. A trusted local agent submits one
// corpus-grounded draft as PLAIN text; the server wraps it into a document, applies the identical
// size/shape/non-blank validation, runs exact/near (and optional explicit-sense lexical) matching, and
// stages ONE opaque, expiring attempt. It writes no Note/prompt/card/event/link/receipt — no learning state
// exists until a later commit issue. These schemas are the whole wire vocabulary the tool exposes.

// The only tool the local MCP server exposes. Named once here so the server registration, the discovery
// assertion, and the retirement guard all reference a single constant.
export const PREVIEW_CARD_CREATION_TOOL = "preview_card_creation";

// A generous upper bound on each plain-text field so an untrusted client cannot submit an unbounded body.
// A card's Question/Answer/Success check is short prose; this only fences abuse, never shapes real drafts.
export const MCP_PREVIEW_TEXT_MAX_LENGTH = 10_000;

// The stable caller id bounds so a replay key cannot itself be an unbounded payload.
export const MCP_PREVIEW_REQUEST_ID_MAX_LENGTH = 200;

// A plain-text card field: present, non-empty, non-whitespace, and bounded. The document wrapper and its
// server-derived readable text are the authoritative non-blank gate; this rejects the obvious empty/oversized
// cases at the wire before any matching runs.
const nonBlankText = z
  .string()
  .min(1)
  .max(MCP_PREVIEW_TEXT_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, { message: "must not be blank." });

// The MCP preview input. Deliberately narrow: a caller-stable `requestId` (the replay key), plain
// `question`/`answer`, an optional plain `successCheck`, and an optional WordNet `sense` REF returned by a
// prior preview. `.strict()` rejects any batch/array, user id, Note override, FSRS/due/event field, file path,
// SQL, model config, or arbitrary rich JSON — the transport carries only what a preview needs.
export const mcpPreviewCardInputSchema = z
  .object({
    requestId: z.string().trim().min(1).max(MCP_PREVIEW_REQUEST_ID_MAX_LENGTH),
    question: nonBlankText,
    answer: nonBlankText,
    successCheck: nonBlankText.optional(),
    sense: relatedMaterialSenseRefSchema.optional()
  })
  .strict();

export type McpPreviewCardInput = z.infer<typeof mcpPreviewCardInputSchema>;

// The rendered card the client MUST present verbatim for learner approval: the server-derived readable
// Question and Answer, plus the Success check when the draft grades against one (else null). Derived from the
// wrapped documents server-side, never echoed from client plaintext.
export const mcpRenderedCardSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
    successCheck: z.string().nullable()
  })
  .strict();

export type McpRenderedCard = z.infer<typeof mcpRenderedCardSchema>;

// The optional lexical evidence attached to a preview. `senses` is returned when the caller supplied no sense
// (step 1 — the choices to pick from); `relations` is returned when the caller supplied a sense (step 2 — the
// owner's related saved notes under it). Both reuse the shared "Find related material" outcomes, so MCP never
// re-derives lexical policy. A caller whose Answer is not one eligible word simply gets an `unsupported`/
// `not_found` status inside the reused outcome.
export const mcpRelatedMaterialSchema = z.discriminatedUnion("mode", [
  z
    .object({ mode: z.literal("senses"), senses: relatedMaterialSensesResponseSchema })
    .strict(),
  z
    .object({ mode: z.literal("relations"), relations: relatedMaterialRelationsResponseSchema })
    .strict()
]);

export type McpRelatedMaterial = z.infer<typeof mcpRelatedMaterialSchema>;

// The one safe next action a preview ever advertises: present the exact rendered card and obtain learner
// approval before any commit. It is a fixed literal so the client can never be steered into an autonomous
// mutation by the tool.
export const mcpPreviewNextActionSchema = z.literal("present_preview_and_request_approval");

// The discriminated preview result carried as the tool's structured content. `previewed` staged the opaque
// attempt and returns the rendered card, the two typed candidate groups, the optional lexical evidence, the
// attempt id/expiry, `approvalRequired: true`, and the safe next action. The `invalid_*` variants are the
// document-boundary rejections (a field whose derived text is only whitespace, or an invalid Success check);
// `changed_payload` is a replay of the same `requestId` with a DIFFERENT draft against a still-live attempt.
export const mcpPreviewCardResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("previewed"),
      attemptId: z.string(),
      expiresAt: z.string(),
      approvalRequired: z.literal(true),
      nextAction: mcpPreviewNextActionSchema,
      renderedCard: mcpRenderedCardSchema,
      candidates: z.array(materialReviewCandidateDtoSchema),
      nearCandidates: z.array(nearMaterialReviewCandidateDtoSchema),
      candidateFingerprint: z.string(),
      revision: z.number().int().nonnegative(),
      relatedMaterial: mcpRelatedMaterialSchema
    })
    .strict(),
  z.object({ status: z.literal("invalid_question") }).strict(),
  z.object({ status: z.literal("invalid_answer") }).strict(),
  z.object({ status: z.literal("invalid_success_check") }).strict(),
  z.object({ status: z.literal("changed_payload") }).strict()
]);

export type McpPreviewCardResult = z.infer<typeof mcpPreviewCardResultSchema>;

export function parseMcpPreviewCardInput(value: unknown): McpPreviewCardInput {
  return mcpPreviewCardInputSchema.parse(value);
}

export function parseMcpPreviewCardResult(value: unknown): McpPreviewCardResult {
  return mcpPreviewCardResultSchema.parse(value);
}
