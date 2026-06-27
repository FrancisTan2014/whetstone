import type {
  AuthorCaseBrief,
  AuthorCaseResult,
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
}
