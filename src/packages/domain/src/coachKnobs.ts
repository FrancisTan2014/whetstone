// Pure derivation of the coach's adaptive knobs from the learner-model snapshot (#223). The coach is a
// FIXED skill; it behaves differently round to round only because these knobs — its briefing inputs —
// change, never because the skill template is rewritten (the self-tuning coach is deferred). No LLM call,
// no I/O: knobs are a deterministic function of the model, so the same snapshot always yields the same
// knobs and the whole derivation is unit-testable.

import type { ErrorCategory, ProficiencyLevel } from "./learnerModel.js";

// The challenge / support intensity scale, and the pace and register the coach is briefed to adopt.
export const coachIntensities = ["low", "medium", "high"] as const;
export type CoachIntensity = (typeof coachIntensities)[number];

export const coachPaces = ["slow", "steady", "brisk"] as const;
export type CoachPace = (typeof coachPaces)[number];

export const coachRegisters = ["casual", "neutral", "formal"] as const;
export type CoachRegister = (typeof coachRegisters)[number];

// The bounded slice of the learner model the knobs read: the current proficiency band, the top error
// patterns (most frequent first), how many chunks are due, the recent outcome grades (0..5), and the
// topic the model is steering toward (its top gap).
export type LearnerSnapshot = Readonly<{
  band: ProficiencyLevel;
  topErrorPatterns: ReadonlyArray<ErrorCategory>;
  dueChunkCount: number;
  recentGrades: ReadonlyArray<number>;
  focus: string;
}>;

export type CoachKnobs = Readonly<{
  // Target difficulty band — bumped a level when the learner is clearly advancing.
  targetBand: ProficiencyLevel;
  // How hard the coach pushes vs. how much it scaffolds (support is the inverse of challenge).
  challenge: CoachIntensity;
  support: CoachIntensity;
  // The specific error patterns to probe this round (capped, most frequent first).
  probeErrorPatterns: ReadonlyArray<ErrorCategory>;
  register: CoachRegister;
  // The topic to steer toward (the model's top gap).
  focus: string;
  pace: CoachPace;
}>;

// At most this many error patterns are probed in one round, to keep repair light and focused.
const MAX_PROBE_PATTERNS = 2;
// Recent-average thresholds: at/above ADVANCE the learner is pushed up; below STRUGGLE they get more
// support.
const ADVANCE_AVG = 4;
const STRUGGLE_AVG = 2.5;

// Total maps over the closed unions, so member access is always defined (no index-out-of-range path).
const nextBand: Readonly<Record<ProficiencyLevel, ProficiencyLevel>> = {
  advanced: "advanced",
  beginner: "elementary",
  elementary: "intermediate",
  intermediate: "advanced"
};

const bandChallenge: Readonly<Record<ProficiencyLevel, CoachIntensity>> = {
  advanced: "high",
  beginner: "low",
  elementary: "low",
  intermediate: "medium"
};

const bandPace: Readonly<Record<ProficiencyLevel, CoachPace>> = {
  advanced: "brisk",
  beginner: "slow",
  elementary: "steady",
  intermediate: "steady"
};

const bandRegister: Readonly<Record<ProficiencyLevel, CoachRegister>> = {
  advanced: "formal",
  beginner: "casual",
  elementary: "casual",
  intermediate: "neutral"
};

const raiseIntensity: Readonly<Record<CoachIntensity, CoachIntensity>> = {
  high: "high",
  low: "medium",
  medium: "high"
};

const lowerIntensity: Readonly<Record<CoachIntensity, CoachIntensity>> = {
  high: "medium",
  low: "low",
  medium: "low"
};

const invertIntensity: Readonly<Record<CoachIntensity, CoachIntensity>> = {
  high: "low",
  low: "high",
  medium: "medium"
};

function averageGrade(grades: ReadonlyArray<number>): number | null {
  if (grades.length === 0) {
    return null;
  }
  return grades.reduce((sum, grade) => sum + grade, 0) / grades.length;
}

export function deriveCoachKnobs(snapshot: LearnerSnapshot): CoachKnobs {
  const average = averageGrade(snapshot.recentGrades);
  const advancing = average !== null && average >= ADVANCE_AVG;
  const struggling = average !== null && average < STRUGGLE_AVG;

  const targetBand = advancing ? nextBand[snapshot.band] : snapshot.band;

  let challenge = bandChallenge[targetBand];
  if (advancing) {
    challenge = raiseIntensity[challenge];
  } else if (struggling) {
    challenge = lowerIntensity[challenge];
  }

  return {
    challenge,
    focus: snapshot.focus,
    pace: bandPace[targetBand],
    probeErrorPatterns: snapshot.topErrorPatterns.slice(0, MAX_PROBE_PATTERNS),
    register: bandRegister[targetBand],
    support: invertIntensity[challenge],
    targetBand
  };
}
