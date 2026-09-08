import { z } from "zod";

import { entryIdDtoSchema } from "./entryContracts.js";

// The semantic-map explanation API (#924): a read-only, opt-in POST that explains how a selected
// word/phrase's principal meanings relate — a core image/schema (or separate sense families when one
// core would be false), each family's principal branches (their connection to the core + a short
// natural expression), and which branch the current passage uses. This is deliberately NOT a
// dictionary entry and NOT the legacy `/api/lookup` "AI 解释" contextual gloss (`lookupContracts.ts`):
// it is a new, independently-opt-in capability with its own shared contract, consumed next by the
// Reader (#925).

// One canonical prompt version string, shared between the server's prompt builder and its cache key so
// a prompt revision can never silently reuse a stale-shape cached answer. Kept here (not only in the
// server) so a future consumer can reason about which prompt generation produced a cached result.
export const EXPLAIN_PROMPT_VERSION = "semantic-map-v1";

// --------------------------------------------------------------------------------------------------
// Request: the existing selection's Work/block identity and exact range, plus the client's own
// snapshot of the selected text — the evidence the server uses to detect a stale selection (the block
// changed under the learner between selecting and asking). There is no client-supplied context or
// language: both are resolved canonically server-side from the Work/block themselves.
// --------------------------------------------------------------------------------------------------

const MAX_SELECTED_TEXT_LENGTH = 300;

export const explainRequestSchema = z
  .object({
    blockEntryId: entryIdDtoSchema,
    endOffset: z.number().int().nonnegative(),
    selectedText: z
      .string()
      .min(1, { message: "selectedText must be non-empty." })
      .max(MAX_SELECTED_TEXT_LENGTH),
    startOffset: z.number().int().nonnegative(),
    workEntryId: entryIdDtoSchema
  })
  .strict()
  .refine((value) => value.endOffset > value.startOffset, {
    message: "endOffset must be greater than startOffset.",
    path: ["endOffset"]
  })
  .refine((value) => value.selectedText.trim().length > 0, {
    message: "selectedText must contain a non-whitespace headword.",
    path: ["selectedText"]
  });

export type ExplainRequest = z.infer<typeof explainRequestSchema>;

export function parseExplainRequest(value: unknown): ExplainRequest {
  return explainRequestSchema.parse(value);
}

// --------------------------------------------------------------------------------------------------
// Result: the organizing map itself. A compact, bounded shape rather than a generalized document — one
// or more sense families (usually one; more than one only when a single core would be false, e.g. an
// English homograph or a Chinese polyphonic reading), each with its principal branches. Every id is
// local to this one response and used only to cross-reference `currentFamilyId`/`currentBranchId` and
// an optional per-family pronunciation entry.
// --------------------------------------------------------------------------------------------------

const explainBranchSchema = z
  .object({
    connection: z.string().trim().min(1, { message: "connection must be non-empty." }).max(400),
    example: z.string().trim().min(1, { message: "example must be non-empty." }).max(200),
    id: z.string().trim().min(1, { message: "branch id must be non-empty." }).max(64),
    label: z.string().trim().min(1, { message: "label must be non-empty." }).max(80)
  })
  .strict();

export type ExplainBranch = z.infer<typeof explainBranchSchema>;

const explainFamilySchema = z
  .object({
    branches: z.array(explainBranchSchema).min(1).max(6),
    coreImage: z.string().trim().min(1, { message: "coreImage must be non-empty." }).max(400),
    id: z.string().trim().min(1, { message: "family id must be non-empty." }).max(64)
  })
  .strict();

export type ExplainFamily = z.infer<typeof explainFamilySchema>;

const explainPronunciationSchema = z
  .object({
    familyId: z.string().trim().min(1).max(64).optional(),
    label: z.string().trim().min(1, { message: "pronunciation label must be non-empty." }).max(40),
    value: z.string().trim().min(1, { message: "pronunciation value must be non-empty." }).max(80)
  })
  .strict();

export type ExplainPronunciation = z.infer<typeof explainPronunciationSchema>;

export const explainLanguages = ["en", "zh"] as const;
export type ExplainLanguage = (typeof explainLanguages)[number];

const EXPLAIN_NOTE_MAX_LENGTH = 500;

const explainResultBaseSchema = z
  .object({
    // Reliable pronunciation, nuance/register, everyday usage, etymology, and cultural context are all
    // conditional supporting fields — present only when the model has something real to say — never six
    // obligatory essays. Etymology/cultural notes must reflect a real connection; the prompt instructs
    // the model never to invent one.
    culturalNote: z.string().trim().min(1).max(EXPLAIN_NOTE_MAX_LENGTH).optional(),
    currentBranchId: z
      .string()
      .trim()
      .min(1, { message: "currentBranchId must be non-empty." })
      .max(64),
    currentFamilyId: z
      .string()
      .trim()
      .min(1, { message: "currentFamilyId must be non-empty." })
      .max(64),
    etymology: z.string().trim().min(1).max(EXPLAIN_NOTE_MAX_LENGTH).optional(),
    families: z.array(explainFamilySchema).min(1).max(4),
    headword: z.string().trim().min(1, { message: "headword must be non-empty." }).max(200),
    language: z.enum(explainLanguages),
    nuance: z.string().trim().min(1).max(EXPLAIN_NOTE_MAX_LENGTH).optional(),
    // Polyphonic Chinese readings (and, more rarely, English homographs) tie a distinct pronunciation to
    // a distinct sense family; `familyId` is optional because most words have exactly one reading.
    pronunciation: z.array(explainPronunciationSchema).max(6).optional(),
    usageNote: z.string().trim().min(1).max(EXPLAIN_NOTE_MAX_LENGTH).optional()
  })
  .strict();

// Cross-reference validation: `currentFamilyId`/`currentBranchId` (and any pronunciation `familyId`)
// must name a family/branch that actually exists in this same response, and no family or branch id may
// repeat. Invalid or incomplete model output is rejected here rather than partially salvaged into a
// dictionary-shaped fallback.
export const explainResultSchema = explainResultBaseSchema.superRefine((value, ctx) => {
  const familyIds = new Set<string>();
  for (const family of value.families) {
    if (familyIds.has(family.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate family id "${family.id}".`,
        path: ["families"]
      });
    }
    familyIds.add(family.id);
  }

  const branchIds = new Set<string>();
  for (const family of value.families) {
    for (const branch of family.branches) {
      if (branchIds.has(branch.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate branch id "${branch.id}".`,
          path: ["families"]
        });
      }
      branchIds.add(branch.id);
    }
  }

  if (!familyIds.has(value.currentFamilyId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currentFamilyId "${value.currentFamilyId}" does not match any family.`,
      path: ["currentFamilyId"]
    });
  }

  if (!branchIds.has(value.currentBranchId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currentBranchId "${value.currentBranchId}" does not match any branch.`,
      path: ["currentBranchId"]
    });
  }

  for (const entry of value.pronunciation ?? []) {
    if (entry.familyId !== undefined && !familyIds.has(entry.familyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pronunciation familyId "${entry.familyId}" does not match any family.`,
        path: ["pronunciation"]
      });
    }
  }
});

export type ExplainResult = z.infer<typeof explainResultSchema>;

export function parseExplainResult(value: unknown): ExplainResult {
  return explainResultSchema.parse(value);
}

// --------------------------------------------------------------------------------------------------
// Response: a discriminated union so the client renders a distinct, understandable state for every
// named outcome instead of guessing from an error string. `unavailable` carries the seam's own named
// reason (never a raw SDK error or stack). Only `ok` is ever cache-eligible server-side.
// --------------------------------------------------------------------------------------------------

const explainProviderAttributionSchema = z
  .object({
    // Actual provider-reported attribution (from the turn's own usage evidence), never fabricated from
    // requested configuration. Absent when the runtime reported nothing.
    model: z.string().optional(),
    reasoningEffort: z.string().optional()
  })
  .strict();

export type ExplainProviderAttribution = z.infer<typeof explainProviderAttributionSchema>;

export const explainUnavailableReasons = [
  "startup_failed",
  "unsupported_model",
  "transport_failed"
] as const;
export type ExplainUnavailableReason = (typeof explainUnavailableReasons)[number];

export const explainResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      result: explainResultSchema,
      provider: explainProviderAttributionSchema
    })
    .strict(),
  // The capability is opted out (default) — the reader should show its own disabled affordance, never
  // silently hide the entry point.
  z.object({ status: z.literal("disabled") }).strict(),
  // The named Work/block does not exist, is not owned by that Work, or is soft-deleted.
  z.object({ status: z.literal("not_found") }).strict(),
  // The client's selectedText/offsets no longer match the block's canonical plaintext: the source
  // changed underneath the learner. Never substituted with an unrelated passage.
  z.object({ status: z.literal("stale_selection") }).strict(),
  // The whole request (including session setup) exceeded its owned deadline.
  z.object({ status: z.literal("timeout") }).strict(),
  // The model's answer was not valid JSON, or failed the shared response contract (missing/invalid
  // fields, bad cross-references, duplicate ids). Never partially salvaged.
  z.object({ status: z.literal("invalid_response") }).strict(),
  // The Copilot runtime itself failed — a named, non-timeout reason from the agent seam.
  z.object({ status: z.literal("unavailable"), reason: z.enum(explainUnavailableReasons) }).strict()
]);

export type ExplainResponse = z.infer<typeof explainResponseSchema>;

export function parseExplainResponse(value: unknown): ExplainResponse {
  return explainResponseSchema.parse(value);
}

// --------------------------------------------------------------------------------------------------
// Capability: a truthful, read-only report of whether the Reader (#925) may show the explanation entry
// point at all. `enabled: true` means the capability is opted in and its configuration is valid — it
// does NOT mean an authentication/model generation has already succeeded; that is only ever discovered
// by a real POST /api/explain call.
// --------------------------------------------------------------------------------------------------

export const explainCapabilityDisabledReasons = ["feature_disabled"] as const;
export type ExplainCapabilityDisabledReason = (typeof explainCapabilityDisabledReasons)[number];

export const explainCapabilitySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true) }).strict(),
  z
    .object({
      enabled: z.literal(false),
      reason: z.enum(explainCapabilityDisabledReasons),
      remedy: z.string()
    })
    .strict()
]);

export type ExplainCapability = z.infer<typeof explainCapabilitySchema>;

export function parseExplainCapability(value: unknown): ExplainCapability {
  return explainCapabilitySchema.parse(value);
}
