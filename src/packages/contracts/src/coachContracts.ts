import { z } from "zod";

// Shared, Zod-validated boundary shapes for the coach LLM seam (#206). Every value crossing the seam
// — the judgement a model returns, a proposed next cue, an authored case — is described here so the
// real adapter validates untrusted model output once at the boundary and the rest of the app trusts
// typed data. The deterministic fake produces the same shapes, so the loop builds and runs with no key.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The discrete production verdict, worst -> best. Mirrors `productionCategories` in
// `@whetstone/domain` (`coachGrade.ts`), which owns the verdict -> SM-2 grade mapping; keep in sync.
export const productionCategories = [
  "off_target",
  "incorrect",
  "awkward",
  "understandable",
  "good",
  "native_like"
] as const;

export const productionCategorySchema = z.enum(productionCategories);

export type ProductionCategory = z.infer<typeof productionCategorySchema>;

// What kind of thing a diagnosed issue is, and how much it matters.
export const productionIssueKinds = [
  "grammar",
  "word_choice",
  "collocation",
  "register",
  "pronunciation",
  "other"
] as const;

export const productionIssueSeverities = ["minor", "major"] as const;

export const productionIssueSchema = z
  .object({
    kind: z.enum(productionIssueKinds),
    note: z.string().refine(isNonBlank, { message: "note must be non-empty." }),
    severity: z.enum(productionIssueSeverities)
  })
  .strict();

export type ProductionIssue = z.infer<typeof productionIssueSchema>;

// The coach's judgement of one spoken attempt: a 0..1 naturalness score for display, a discrete
// `category` that drives scheduling, and a diagnosis list.
export const productionJudgementSchema = z
  .object({
    category: productionCategorySchema,
    issues: z.array(productionIssueSchema),
    natural: z.number().min(0).max(1)
  })
  .strict();

export type ProductionJudgement = z.infer<typeof productionJudgementSchema>;

// The compiled learner context handed to the coach: a short focus and the recently practised targets.
// Kept small and model-agnostic — the app compiles it; the coach never reaches into storage.
export const compiledContextSchema = z
  .object({
    focus: z.string(),
    recentTargets: z.array(z.string())
  })
  .strict();

export type CompiledContext = z.infer<typeof compiledContextSchema>;

export const judgeProductionRequestSchema = z
  .object({
    context: compiledContextSchema,
    target: z.string().refine(isNonBlank, { message: "target must be non-empty." }),
    transcript: z.string()
  })
  .strict();

export type JudgeProductionRequest = z.infer<typeof judgeProductionRequestSchema>;

// A conversational turn in a live coaching call: who spoke and what was said. The learner's text may be
// empty (they went quiet / were unintelligible — a breakdown the coach repairs); the coach's never is.
export const conversationRoles = ["user", "coach"] as const;

export const conversationRoleSchema = z.enum(conversationRoles);

export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const conversationTurnSchema = z
  .object({ role: conversationRoleSchema, text: z.string() })
  .strict();

export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

// One conversational coaching exchange (#220): the conversation so far + the compiled learner context +
// the case the call is set in. The coach returns its next spoken line and an optional light-repair
// signal. This is what the live call loop (#221) calls on every user turn — grading is the end-of-round
// job (#222), never per turn.
export const coachConverseRequestSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlank, { message: "communicativeFunction must be non-empty." }),
    context: compiledContextSchema,
    history: z.array(conversationTurnSchema),
    situation: z.string().refine(isNonBlank, { message: "situation must be non-empty." })
  })
  .strict();

export type CoachConverseRequest = z.infer<typeof coachConverseRequestSchema>;

// The light-repair signal, present ONLY on a real breakdown (the learner is stuck or unintelligible):
// what broke down and the gentle recast/scaffold the coach offers to get them producing again. Absent
// when the learner is in flow — the coach stays in flow and does not grade.
export const coachRepairSchema = z
  .object({
    reason: z.string().refine(isNonBlank, { message: "reason must be non-empty." }),
    recast: z.string().refine(isNonBlank, { message: "recast must be non-empty." })
  })
  .strict();

export type CoachRepair = z.infer<typeof coachRepairSchema>;

// The coach's reply for one turn: the next spoken line (always present), plus `repair` only on a real
// breakdown.
export const coachConverseResultSchema = z
  .object({
    repair: coachRepairSchema.optional(),
    say: z.string().refine(isNonBlank, { message: "say must be non-empty." })
  })
  .strict();

export type CoachConverseResult = z.infer<typeof coachConverseResultSchema>;

// The navigation step: the next thing to elicit, an optional link to a corpus chunk (#205), and the
// cue shown to the learner.
export const proposeNextResultSchema = z
  .object({
    chunkId: z.string().nullable(),
    cue: z.string().refine(isNonBlank, { message: "cue must be non-empty." }),
    target: z.string().refine(isNonBlank, { message: "target must be non-empty." })
  })
  .strict();

export type ProposeNextResult = z.infer<typeof proposeNextResultSchema>;

// A brief for authoring a new case into the corpus.
export const authorCaseBriefSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlank, { message: "communicativeFunction must be non-empty." }),
    domainId: z.string().refine(isNonBlank, { message: "domainId must be non-empty." }).nullish(),
    situation: z.string().refine(isNonBlank, { message: "situation must be non-empty." })
  })
  .strict();

export type AuthorCaseBrief = z.infer<typeof authorCaseBriefSchema>;

// An authored chunk proposal (no persisted ids yet — those are assigned on save).
export const authoredChunkSchema = z
  .object({
    gloss: z.string().nullable(),
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." }),
    usageNote: z.string().nullable()
  })
  .strict();

export type AuthoredChunk = z.infer<typeof authoredChunkSchema>;

// An authored case + its chunk inventory, ready to be reviewed and persisted into the corpus. The
// situation/function are model output crossing the seam, so they carry the same non-blank validation
// as the authoring brief.
export const authorCaseResultSchema = z
  .object({
    chunks: z.array(authoredChunkSchema),
    communicativeFunction: z
      .string()
      .refine(isNonBlank, { message: "communicativeFunction must be non-empty." }),
    situation: z.string().refine(isNonBlank, { message: "situation must be non-empty." })
  })
  .strict();

export type AuthorCaseResult = z.infer<typeof authorCaseResultSchema>;

export function parseProductionJudgement(value: unknown): ProductionJudgement {
  return productionJudgementSchema.parse(value);
}

export function parseCoachConverseResult(value: unknown): CoachConverseResult {
  return coachConverseResultSchema.parse(value);
}

export function parseProposeNextResult(value: unknown): ProposeNextResult {
  return proposeNextResultSchema.parse(value);
}

export function parseAuthorCaseResult(value: unknown): AuthorCaseResult {
  return authorCaseResultSchema.parse(value);
}
