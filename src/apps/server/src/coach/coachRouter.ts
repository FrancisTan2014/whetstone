import type {
  AuthorCaseBrief,
  AuthorCaseResult,
  CompiledContext,
  JudgeProductionRequest,
  ProductionJudgement,
  ProposeNextResult
} from "@whetstone/contracts";
import type { ReviewGrade } from "@whetstone/domain";

import type { CoachProvider } from "./coachProvider.js";

// Cost-routing is a config seam, not a hardcoded model choice: each model-calling operation is routed
// to a "strong" or "cheap" tier per call type. The default routes the few coaching judgements to the
// strong model and the bulk (propose/author) to the cheap one — overridable by config.
export const coachCallTypes = ["judge", "propose", "author"] as const;

export type CoachCallType = (typeof coachCallTypes)[number];

export const coachTiers = ["cheap", "strong"] as const;

export type CoachTier = (typeof coachTiers)[number];

export type CostRouting = Readonly<Record<CoachCallType, CoachTier>>;

export const defaultCostRouting: CostRouting = Object.freeze({
  author: "cheap",
  judge: "strong",
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
    authorCase(brief: AuthorCaseBrief): Promise<AuthorCaseResult> {
      return providerFor("author").authorCase(brief);
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
