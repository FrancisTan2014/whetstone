import type {
  AuthorCaseBrief,
  AuthorCaseResult,
  AuthoredChunk,
  CompiledContext,
  JudgeProductionRequest,
  ProductionCategory,
  ProductionIssue,
  ProductionJudgement,
  ProposeNextResult
} from "@whetstone/contracts";
import { judgementToGrade, type ReviewGrade } from "@whetstone/domain";

import type { CoachProvider } from "./coachProvider.js";

// A deterministic coach with no model and no network, so the whole language loop builds, tests, and
// runs green with no API key (the keyless dev mode). Its judgement is a transparent function of how
// much of the target the learner reproduced — meaningful enough to drive the loop, deterministic
// enough to assert exactly.

function tokenize(value: string): ReadonlyArray<string> {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Pick the verdict from the share of target words the transcript reproduced. Exact (normalized)
// matches are handled before this; here 0 means nothing landed and 1 means every target word is
// present but the wording is not identical.
function categoryForOverlap(overlap: number): ProductionCategory {
  if (overlap === 0) {
    return "off_target";
  }
  if (overlap < 0.5) {
    return "incorrect";
  }
  if (overlap < 0.75) {
    return "awkward";
  }
  if (overlap < 1) {
    return "understandable";
  }
  return "good";
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function judge(target: string, transcript: string): ProductionJudgement {
  if (normalize(transcript).length === 0) {
    return { category: "off_target", issues: [], natural: 0 };
  }

  if (normalize(target) === normalize(transcript)) {
    return { category: "native_like", issues: [], natural: 1 };
  }

  const targetTokens = tokenize(target);
  const transcriptTokens = new Set(tokenize(transcript));
  const missing = targetTokens.filter((token) => !transcriptTokens.has(token));
  const overlap = targetTokens.length === 0 ? 0 : 1 - missing.length / targetTokens.length;
  const category = categoryForOverlap(overlap);

  const issues: ProductionIssue[] =
    missing.length === 0
      ? []
      : [
          {
            kind: "word_choice",
            note: `Missing key words: ${missing.join(", ")}.`,
            severity: overlap < 0.5 ? "major" : "minor"
          }
        ];

  return { category, issues, natural: overlap };
}

function firstNonBlank(candidates: ReadonlyArray<string>): string {
  return candidates.find((candidate) => candidate.trim().length > 0) ?? "How's it going?";
}

function propose(context: CompiledContext): ProposeNextResult {
  const target = firstNonBlank([context.focus, ...context.recentTargets]);
  return { chunkId: null, cue: `Say something natural for: ${target}`, target };
}

function author(brief: AuthorCaseBrief): AuthorCaseResult {
  const chunks: AuthoredChunk[] = [
    { gloss: null, text: `Could we talk about ${brief.situation}?`, usageNote: null },
    {
      gloss: null,
      text: `I'd like to ${brief.communicativeFunction.toLowerCase()}.`,
      usageNote: null
    },
    { gloss: "a simple fallback phrasing", text: "Let's keep it simple.", usageNote: null }
  ];

  return {
    chunks,
    communicativeFunction: brief.communicativeFunction,
    situation: brief.situation
  };
}

export function createFakeCoach(): CoachProvider {
  return Object.freeze({
    authorCase(brief: AuthorCaseBrief): Promise<AuthorCaseResult> {
      return Promise.resolve(author(brief));
    },
    gradeForScheduler(judgement: ProductionJudgement): ReviewGrade {
      return judgementToGrade(judgement.category);
    },
    judgeProduction(request: JudgeProductionRequest): Promise<ProductionJudgement> {
      return Promise.resolve(judge(request.target, request.transcript));
    },
    proposeNext(context: CompiledContext): Promise<ProposeNextResult> {
      return Promise.resolve(propose(context));
    }
  });
}
