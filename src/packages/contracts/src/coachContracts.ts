import { z } from "zod";

import {
  compiledLearnerContextDtoSchema,
  errorCategorySchema,
  proficiencyLevelSchema
} from "./learnerContracts.js";
import { transcribedWordSchema } from "./speechContracts.js";

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

// The coach's adaptive knobs (#223): difficulty/focus derived deterministically from the learner model
// (see `deriveCoachKnobs` in `@whetstone/domain`), briefing the FIXED coach skill. Carried on the coach
// calls so each round's difficulty and focus reflect the learner's current model. The enum literals
// mirror the domain (`coachKnobs.ts`); keep in sync.
export const coachKnobsSchema = z
  .object({
    challenge: z.enum(["low", "medium", "high"]),
    focus: z.string(),
    pace: z.enum(["slow", "steady", "brisk"]),
    probeErrorPatterns: z.array(errorCategorySchema),
    register: z.enum(["casual", "neutral", "formal"]),
    support: z.enum(["low", "medium", "high"]),
    targetBand: proficiencyLevelSchema
  })
  .strict();

export type CoachKnobs = z.infer<typeof coachKnobsSchema>;

// One conversational coaching exchange (#220): the conversation so far + the compiled learner context +
// the case the call is set in + the adaptive knobs (#223). The coach returns its next spoken line and an
// optional light-repair signal. This is what the live call loop (#221) calls on every user turn —
// grading is the end-of-round job (#222), never per turn.
export const coachConverseRequestSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlank, { message: "communicativeFunction must be non-empty." }),
    context: compiledContextSchema,
    history: z.array(conversationTurnSchema),
    knobs: coachKnobsSchema,
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

// One target chunk the round practised: the native phrasing to grade against what the learner said.
export const roundChunkSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }),
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." })
  })
  .strict();

export type RoundChunk = z.infer<typeof roundChunkSchema>;

// The end-of-round analysis input (#222): the whole conversation + STT word-timings + the case's target
// chunks + the **compiled learner context** (the real bounded slice — rolling profile + due/ranked
// chunks + top error patterns + recent outcomes — so the coach chooses high-value mistakes, wins, and
// the upgrade against the learner model, closing the compounding loop). The coach runs ONE pass over
// this and returns a structured result; this is the only place a round is graded. Validated at the
// boundary.
export const analyzeRoundRequestSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlank, { message: "communicativeFunction must be non-empty." }),
    context: compiledLearnerContextDtoSchema,
    history: z.array(conversationTurnSchema),
    knobs: coachKnobsSchema,
    situation: z.string().refine(isNonBlank, { message: "situation must be non-empty." }),
    targetChunks: z.array(roundChunkSchema),
    words: z.array(transcribedWordSchema)
  })
  .strict();

export type AnalyzeRoundRequest = z.infer<typeof analyzeRoundRequestSchema>;

// A grade (0..5, SM-2) for one target chunk — how well the learner produced it across the round.
export const chunkGradeSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }),
    grade: z.number().int().min(0).max(5)
  })
  .strict();

export type ChunkGrade = z.infer<typeof chunkGradeSchema>;

// One high-value mistake, tagged to the error taxonomy (#208): what the learner said, the native form,
// and a short why. The deposit increments the tagged category's pattern count.
export const analyzedMistakeSchema = z
  .object({
    category: errorCategorySchema,
    native: z.string().refine(isNonBlank, { message: "native must be non-empty." }),
    said: z.string(),
    why: z.string().refine(isNonBlank, { message: "why must be non-empty." })
  })
  .strict();

export type AnalyzedMistake = z.infer<typeof analyzedMistakeSchema>;

// The single native upgrade to carry forward: a said -> native pair.
export const nativeUpgradeSchema = z
  .object({
    native: z.string().refine(isNonBlank, { message: "native must be non-empty." }),
    said: z.string().refine(isNonBlank, { message: "said must be non-empty." })
  })
  .strict();

export type NativeUpgrade = z.infer<typeof nativeUpgradeSchema>;

// The structured end-of-round result: a grade per target chunk, the 2-3 highest-value tagged mistakes,
// wins, one native upgrade, and a line of encouragement. The deterministic deposit reads only this.
export const analyzeRoundResultSchema = z
  .object({
    chunkGrades: z.array(chunkGradeSchema),
    encouragement: z.string().refine(isNonBlank, { message: "encouragement must be non-empty." }),
    mistakes: z.array(analyzedMistakeSchema),
    upgrade: nativeUpgradeSchema,
    wins: z.array(z.string())
  })
  .strict();

export type AnalyzeRoundResult = z.infer<typeof analyzeRoundResultSchema>;

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

export function parseAnalyzeRoundResult(value: unknown): AnalyzeRoundResult {
  return analyzeRoundResultSchema.parse(value);
}

export function parseProposeNextResult(value: unknown): ProposeNextResult {
  return proposeNextResultSchema.parse(value);
}

export function parseAuthorCaseResult(value: unknown): AuthorCaseResult {
  return authorCaseResultSchema.parse(value);
}
