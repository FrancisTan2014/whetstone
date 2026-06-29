import {
  parseAnalyzeRoundResult,
  parseCoachConverseResult,
  type AnalyzeRoundRequest,
  type AnalyzeRoundResult,
  type AuthorCaseBrief,
  type AuthorCaseResult,
  type CoachConverseRequest,
  type CoachConverseResult,
  type CompiledContext,
  type JudgeProductionRequest,
  type ProductionJudgement,
  type ProposeNextResult
} from "@whetstone/contracts";
import type { ReviewGrade } from "@whetstone/domain";

import type { CoachProvider } from "./coachProvider.js";

// The model boundary: prompt in, completion text out. Real adapters spawn a local Ollama or a cloud
// API behind this; tests inject a deterministic fake, so the judge logic is exercised with no I/O.
export type ChatModel = (prompt: string) => Promise<string>;

export type LlmCoachDependencies = Readonly<{
  chat: ChatModel;
  // Everything except analyze (and gradeForScheduler) delegates here: in v0 only the end-of-round
  // judge is real; converse/judge/propose/author stay on the deterministic fallback (#241).
  fallback: CoachProvider;
}>;

// The rubric (#241): score INTELLIGIBILITY first — was it understood? — then chunk use, NEVER
// nativeness; an intelligible-but-accented attempt grades high. Output is strict JSON the contract
// parses; we send the target chunks and the transcript so grades reflect what was actually said.
function analyzePrompt(request: AnalyzeRoundRequest): string {
  const transcript = request.history
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ");
  const chunks = request.targetChunks.map((chunk) => `${chunk.chunkId}: ${chunk.text}`).join("\n");

  return [
    "You are an English speaking coach. Judge one round, intelligibility first (was it understood?),",
    "then chunk use; never penalize accent or non-nativeness. Reply with ONLY JSON matching:",
    '{"chunkGrades":[{"chunkId","grade":0-5}],"mistakes":[{"category","said","native","why"}],',
    '"wins":[],"upgrade":{"said","native"},"encouragement"}.',
    `Situation: ${request.situation}. Function: ${request.communicativeFunction}.`,
    `Target chunks:\n${chunks}`,
    `Transcript: ${transcript}`
  ].join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object in model output.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

// The in-flow conversational turn (#242): brief the coach with the adaptive knobs (band, challenge/
// support, register, pace) and the history, and ask for one natural next line that keeps the learner
// producing — a light implicit recast only on a real breakdown, never a grade mid-flow. Strict JSON.
function conversePrompt(request: CoachConverseRequest): string {
  const transcript = request.history.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  const { knobs } = request;

  return [
    "You are an English speaking coach in a live call. Stay in flow: reply with the next natural line",
    "for the situation, never a score. Add a gentle recast ONLY on a real breakdown (stuck/unintelligible).",
    `Register: ${knobs.register}. Pace: ${knobs.pace}. Band: ${knobs.targetBand}. Length tracks the band.`,
    `Situation: ${request.situation}. Function: ${request.communicativeFunction}.`,
    'Reply with ONLY JSON: {"say", optional "repair":{"reason","recast"}}.',
    `Conversation:\n${transcript}`
  ].join("\n");
}

// A real coach whose end-of-round analysis is LLM-backed: prompt the model, parse strict JSON to the
// contract. Any model/parse failure degrades to the deterministic fallback so a round always grades.
export function createLlmCoach(dependencies: LlmCoachDependencies): CoachProvider {
  return Object.freeze({
    async analyze(request: AnalyzeRoundRequest): Promise<AnalyzeRoundResult> {
      try {
        return parseAnalyzeRoundResult(
          extractJson(await dependencies.chat(analyzePrompt(request)))
        );
      } catch {
        return dependencies.fallback.analyze(request);
      }
    },
    authorCase: (brief: AuthorCaseBrief): Promise<AuthorCaseResult> =>
      dependencies.fallback.authorCase(brief),
    async converse(request: CoachConverseRequest): Promise<CoachConverseResult> {
      try {
        return parseCoachConverseResult(
          extractJson(await dependencies.chat(conversePrompt(request)))
        );
      } catch {
        return dependencies.fallback.converse(request);
      }
    },
    gradeForScheduler: (judgement: ProductionJudgement): ReviewGrade =>
      dependencies.fallback.gradeForScheduler(judgement),
    judgeProduction: (request: JudgeProductionRequest): Promise<ProductionJudgement> =>
      dependencies.fallback.judgeProduction(request),
    proposeNext: (context: CompiledContext): Promise<ProposeNextResult> =>
      dependencies.fallback.proposeNext(context)
  });
}
