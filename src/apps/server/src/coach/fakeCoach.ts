import type {
  AnalyzeRoundRequest,
  AnalyzeRoundResult,
  AnalyzedMistake,
  AuthorCaseBrief,
  AuthorCaseResult,
  AuthoredChunk,
  ChunkGrade,
  CoachConverseRequest,
  CoachConverseResult,
  CompiledContext,
  ConversationTurn,
  JudgeProductionRequest,
  ProductionCategory,
  ProductionIssue,
  ProductionJudgement,
  ProposeNextResult,
  RoundChunk
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

function lastUserText(history: ReadonlyArray<ConversationTurn>): string | undefined {
  return [...history].reverse().find((turn) => turn.role === "user")?.text;
}

// A deterministic conversational turn (#220): the coach stays in flow, asking a scripted follow-up that
// keeps the learner producing, and offers light repair ONLY on a real breakdown — when the latest user
// turn carried no usable words (stuck / unintelligible). No grading here; that is the end-of-round job.
function converse(request: CoachConverseRequest): CoachConverseResult {
  // The bilingual mix (#270): when any L1 is allowed, push one short English target each turn so L1
  // is a bridge, not a comfort trap. English-only learners (share 0) get the prior English reply.
  const bilingual = request.knobs.targetL1Share > 0;
  const englishTarget = "Let's try that in English.";
  const latest = lastUserText(request.history);
  if (latest !== undefined && tokenize(latest).length === 0) {
    const stuck: CoachConverseResult = {
      repair: {
        reason: "That one didn't quite come through — looks like a tricky spot.",
        recast: `Let's take it slowly. Try one short sentence about: ${request.situation}`
      },
      say: "No rush — let's try a simpler version. Just give me a few words."
    };
    return bilingual ? { ...stuck, englishTarget } : stuck;
  }

  const coachTurns = request.history.filter((turn) => turn.role === "coach").length;
  const say =
    coachTurns === 0
      ? `Let's get into it: ${request.situation}. How would you start?`
      : "Good — keep going. What would you say next?";
  return bilingual ? { englishTarget, say } : { say };
}

// The full learner production across the round: every user turn joined, lowercased for matching.
function roundTranscript(history: ReadonlyArray<ConversationTurn>): string {
  return history
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ")
    .trim();
}

// Tag a chunk's mistake to a taxonomy category deterministically (a stable function of the phrasing):
// longer phrasings read as word-order trouble, short ones as a literal L1 calque. Deterministic so the
// same round always tags the same way and the error-pattern deposit is assertable.
function mistakeCategory(chunk: RoundChunk): AnalyzedMistake["category"] {
  return chunk.text.length > 12 ? "word_order" : "l1_calque";
}

// A deterministic one-pass analysis (#222): grade each target chunk by how much of it the learner
// produced (reusing the same overlap judge), turn the weakest chunks into tagged mistakes, the strongest
// into wins, and derive one native upgrade. No model, no network — assertable exactly.
function analyze(request: AnalyzeRoundRequest): AnalyzeRoundResult {
  const transcript = roundTranscript(request.history);
  const said = transcript.length > 0 ? transcript : "what you tried";

  const graded = request.targetChunks.map((chunk) => ({
    chunk,
    grade: judgementToGrade(judge(chunk.text, transcript).category)
  }));

  const chunkGrades: ChunkGrade[] = graded.map(({ chunk, grade }) => ({
    chunkId: chunk.chunkId,
    grade
  }));

  const mistakes: AnalyzedMistake[] = graded
    .filter(({ grade }) => grade < 3)
    .sort((left, right) => left.grade - right.grade)
    .slice(0, 3)
    .map(({ chunk }) => ({
      category: mistakeCategory(chunk),
      native: chunk.text,
      said,
      why: "Reach for the native phrasing rather than a literal translation."
    }));

  const wins = graded
    .filter(({ grade }) => grade >= 4)
    .map(({ chunk }) => `Nailed "${chunk.text}".`);

  const upgradeNative = request.targetChunks[0]?.text ?? "Keep it natural and concrete.";
  const encouragement =
    wins.length > 0
      ? `Good round — ${wins.length} landed cleanly. Keep building.`
      : "Good effort — let's lock in a couple of phrasings next time.";

  return {
    chunkGrades,
    encouragement,
    mistakes,
    upgrade: { native: upgradeNative, said },
    wins
  };
}

export function createFakeCoach(): CoachProvider {
  return Object.freeze({
    analyze(request: AnalyzeRoundRequest): Promise<AnalyzeRoundResult> {
      return Promise.resolve(analyze(request));
    },
    authorCase(brief: AuthorCaseBrief): Promise<AuthorCaseResult> {
      return Promise.resolve(author(brief));
    },
    converse(request: CoachConverseRequest): Promise<CoachConverseResult> {
      return Promise.resolve(converse(request));
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
