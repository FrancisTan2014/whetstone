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
import type { ReviewRating } from "@whetstone/domain";

import type { LlmModel } from "../llm/llmModel.js";
import type { CoachProvider } from "./coachProvider.js";

// The model boundary: the shared `LlmModel` seam (#385) — prompt in, completion text out. Real adapters
// run a local Ollama (or a cloud provider) behind it; tests inject a deterministic fake, so the judge
// logic is exercised with no I/O.
export type LlmCoachDependencies = Readonly<{
  chat: LlmModel;
  // Everything except analyze (and ratingForScheduler) delegates here: in v0 only the end-of-round
  // judge is real; converse/judge/propose/author stay on the deterministic fallback (#241).
  fallback: CoachProvider;
  // The model name this tier calls (e.g. "llama3.1:8b"), named in the fallback log — never a secret.
  model: string;
  // Observability seam (#432): invoked exactly once, before returning the fake, whenever a real
  // converse/analyze call fails — so a degraded coach is diagnosable at runtime instead of silently
  // masquerading as healthy. A dependency-injected logger like `ingestionLogger`: a fake in tests,
  // a structured `console.warn` in `index.ts`. It only ever receives method/model/reason — never a
  // prompt, transcript, or key.
  onFallback: (info: CoachFallbackInfo) => void;
}>;

// What the fallback log carries: which method degraded, which model it called, and why. No secrets or
// user content by construction — never the prompt, transcript, or an API key.
export type CoachFallbackInfo = Readonly<{
  method: "converse" | "analyze";
  model: string;
  err: string;
}>;

// Normalize an unknown thrown value to a log-safe reason string (an Error's message, else its String).
function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    "then chunk use; never penalize accent or non-nativeness. Reply with ONLY a JSON object with:",
    '"chunkGrades" (array of {"chunkId": string, "rating": one of "again"|"hard"|"good"|"easy"}),',
    '"mistakes" (array of {"category","said","native","why"} strings), "wins" (array of strings),',
    '"upgrade" ({"said","native"} strings), and "encouragement" (string). Example:',
    '{"chunkGrades":[{"chunkId":"c1","rating":"good"}],"mistakes":[],"wins":["Clear"],' +
      '"upgrade":{"said":"","native":""},"encouragement":"Well understood."}',
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
  const bilingual = knobs.targetL1Share > 0;

  const lines = [
    "You are an English speaking coach in a live call. Stay in flow: reply with the next natural line",
    "for the situation, never a score. Add a gentle recast ONLY on a real breakdown (stuck/unintelligible).",
    `Register: ${knobs.register}. Pace: ${knobs.pace}. Band: ${knobs.targetBand}. Length tracks the band.`,
    `Situation: ${request.situation}. Function: ${request.communicativeFunction}.`,
    // Reorientation (#437): a confused learner needs the FORMAT explained, not a language recast.
    "If the learner clearly signals confusion about the format itself (not just a language slip) - e.g.",
    '"what are you talking about", "I don\'t understand", "you\'re just talking to yourself", or an empty',
    "turn - step out of character for ONE short line to reorient them: name the role-play and give a",
    "concrete example of what to say, then return to the scene. Do this at most once; never grade."
  ];

  if (bilingual) {
    // Bilingual mix (#270): meet the learner in their EN/L1 mix to stay understood, but always pull
    // toward English and push ONE English target per turn so L1 is a bridge, not a comfort trap.
    lines.push(
      `The learner is bilingual (L1: ${knobs.l1}). You may use up to about ${Math.round(
        knobs.targetL1Share * 100
      )}% L1 in "say" to stay understood, but ALWAYS keep some English and pull toward it. Each turn,`,
      'recast ONE short English target for them to retry (pushed output) in "englishTarget".',
      'Reply with ONLY a JSON object with a string "say" and a string "englishTarget". Optionally',
      'include a "repair" object with string "reason" and "recast" on a real breakdown. Example:',
      '{"say":"...","englishTarget":"...","repair":{"reason":"...","recast":"..."}}.'
    );
  } else {
    lines.push(
      'Reply with ONLY a JSON object with a string "say". Optionally include a "repair" object with',
      'string "reason" and "recast" on a real breakdown. Example:',
      '{"say":"...","repair":{"reason":"...","recast":"..."}}.'
    );
  }

  lines.push(`Conversation:\n${transcript}`);

  return lines.join("\n");
}

// A real coach whose end-of-round analysis is LLM-backed: prompt the model, parse strict JSON to the
// contract. Any model/parse failure degrades to the deterministic fallback so a round always grades.
export function createLlmCoach(dependencies: LlmCoachDependencies): CoachProvider {
  return Object.freeze({
    async analyze(request: AnalyzeRoundRequest): Promise<AnalyzeRoundResult> {
      try {
        return parseAnalyzeRoundResult(
          extractJson(await dependencies.chat(analyzePrompt(request), { json: true }))
        );
      } catch (error) {
        // Degrade to the fake — but make it visible first, so `local_ready` boot health can't mask a
        // coach that isn't actually answering (#432). One warn per fallback; behavior is unchanged.
        dependencies.onFallback({
          method: "analyze",
          model: dependencies.model,
          err: errorReason(error)
        });
        return dependencies.fallback.analyze(request);
      }
    },
    authorCase: (brief: AuthorCaseBrief): Promise<AuthorCaseResult> =>
      dependencies.fallback.authorCase(brief),
    async converse(request: CoachConverseRequest): Promise<CoachConverseResult> {
      try {
        return parseCoachConverseResult(
          extractJson(await dependencies.chat(conversePrompt(request), { json: true }))
        );
      } catch (error) {
        dependencies.onFallback({
          method: "converse",
          model: dependencies.model,
          err: errorReason(error)
        });
        return dependencies.fallback.converse(request);
      }
    },
    judgeProduction: (request: JudgeProductionRequest): Promise<ProductionJudgement> =>
      dependencies.fallback.judgeProduction(request),
    proposeNext: (context: CompiledContext): Promise<ProposeNextResult> =>
      dependencies.fallback.proposeNext(context),
    ratingForScheduler: (judgement: ProductionJudgement): ReviewRating =>
      dependencies.fallback.ratingForScheduler(judgement)
  });
}
