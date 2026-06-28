import type {
  AnalyzeRoundRequest,
  AnalyzeRoundResult,
  AuthorCaseBrief,
  AuthorCaseResult,
  CoachConverseRequest,
  CoachConverseResult,
  JudgeProductionRequest,
  ProductionJudgement,
  ProposeNextResult,
  CompiledContext
} from "@whetstone/contracts";
import type { ReviewGrade } from "@whetstone/domain";

// The model-agnostic coach seam (#206): a server boundary, like the dictionary-provider seam, that
// the language loop calls without coupling to any model. Every consumer goes through this interface —
// no coaching prompts or logic are baked into consumers. A deterministic fake, cost-routed real
// adapters, or a single model can all sit behind it.
export interface CoachProvider {
  // Judge a spoken attempt: naturalness + an error diagnosis. The model (or fake) reads the target,
  // the learner's transcript, and the compiled context.
  judgeProduction(request: JudgeProductionRequest): Promise<ProductionJudgement>;

  // Map a judgement to the SM-2 grade the scheduler consumes (#188). Pure and tokenless — the LLM
  // grades into the judgement; this just bridges to the scheduler.
  gradeForScheduler(judgement: ProductionJudgement): ReviewGrade;

  // The navigation step: propose the next cue/target from the compiled learner context.
  proposeNext(context: CompiledContext): Promise<ProposeNextResult>;

  // Author a new case + chunk inventory from a brief (used later by case authoring).
  authorCase(brief: AuthorCaseBrief): Promise<AuthorCaseResult>;

  // The conversational turn (#220): given the conversation so far + compiled context + the case, return
  // the coach's next spoken line and a light-repair signal only on a real breakdown. This keeps the
  // learner in flow; grading is the end-of-round job (#222), never per turn.
  converse(request: CoachConverseRequest): Promise<CoachConverseResult>;

  // The end-of-round analysis (#222): ONE pass over the whole round (transcript + word-timings + the
  // case's target chunks + compiled context) returning chunk grades, the top tagged mistakes, wins, and
  // one native upgrade. The deterministic deposit reads only this; grading happens here, never per turn.
  analyze(request: AnalyzeRoundRequest): Promise<AnalyzeRoundResult>;
}
