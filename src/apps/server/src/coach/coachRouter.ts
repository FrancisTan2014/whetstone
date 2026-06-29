import type {
  AnalyzeRoundRequest,
  AnalyzeRoundResult,
  AuthorCaseBrief,
  AuthorCaseResult,
  CoachConverseRequest,
  CoachConverseResult,
  CompiledContext,
  JudgeProductionRequest,
  ProductionJudgement,
  ProposeNextResult
} from "@whetstone/contracts";
import type { ReviewGrade } from "@whetstone/domain";

import type { CoachProvider } from "./coachProvider.js";

// Cost-routing is a config seam, not a hardcoded model choice: each model-calling operation is routed
// to a "strong" or "cheap" tier per call type. The judge that turns the loop honest — the end-of-round
// `analyze` — is the one paid strong call per round; everything else (converse/judge/propose/author)
// runs cheap (local). Overridable per call type via env.
export const coachCallTypes = ["judge", "propose", "author", "converse", "analyze"] as const;

export type CoachCallType = (typeof coachCallTypes)[number];

export const coachTiers = ["cheap", "strong"] as const;

export type CoachTier = (typeof coachTiers)[number];

export type CostRouting = Readonly<Record<CoachCallType, CoachTier>>;

export const defaultCostRouting: CostRouting = Object.freeze({
  analyze: "strong",
  author: "cheap",
  converse: "cheap",
  judge: "cheap",
  propose: "cheap"
});

export type RoutedCoachDependencies = Readonly<{
  cheap: CoachProvider;
  routing: CostRouting;
  strong: CoachProvider;
}>;

// Compose a single CoachProvider that dispatches each model call to the tier its routing selects.
// `gradeForScheduler` is pure (tokenless), so it is not routed — it goes to the strong provider as the
// authoritative grader.
export function createRoutedCoach(dependencies: RoutedCoachDependencies): CoachProvider {
  function providerFor(callType: CoachCallType): CoachProvider {
    return dependencies.routing[callType] === "strong" ? dependencies.strong : dependencies.cheap;
  }

  return Object.freeze({
    analyze(request: AnalyzeRoundRequest): Promise<AnalyzeRoundResult> {
      return providerFor("analyze").analyze(request);
    },
    authorCase(brief: AuthorCaseBrief): Promise<AuthorCaseResult> {
      return providerFor("author").authorCase(brief);
    },
    converse(request: CoachConverseRequest): Promise<CoachConverseResult> {
      return providerFor("converse").converse(request);
    },
    gradeForScheduler(judgement: ProductionJudgement): ReviewGrade {
      return dependencies.strong.gradeForScheduler(judgement);
    },
    judgeProduction(request: JudgeProductionRequest): Promise<ProductionJudgement> {
      return providerFor("judge").judgeProduction(request);
    },
    proposeNext(context: CompiledContext): Promise<ProposeNextResult> {
      return providerFor("propose").proposeNext(context);
    }
  });
}
