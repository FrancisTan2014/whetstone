import type {
  DepositTurnOutcomeRequest,
  LearnerProfileDto,
  ProficiencyLevel,
  TurnOutcomeDto
} from "@whetstone/contracts";
import { deriveLevel, rankChunksByGapFrequency } from "@whetstone/domain";
import { sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { errorPatterns, learnerProfiles, turnOutcomes } from "../../db/schema.js";
import { listErrorPatterns, loadChunkCandidates } from "./learnerQueries.js";

// How many top items feed the rolling profile's structured strengths/weaknesses.
const PROFILE_LIST_LIMIT = 3;

export type LearnerDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
}>;

// Deposit one turn outcome: append it to the log and, when an error was diagnosed, increment that
// category's pattern (frequency + recency) for the user — atomically. This is how the error-pattern
// store updates from each deposited turn.
export async function depositTurnOutcome(
  dependencies: LearnerDependencies,
  request: DepositTurnOutcomeRequest,
  userId: string,
  now: Date
): Promise<TurnOutcomeDto> {
  const chunkId = request.chunkId ?? null;
  const errorCategory = request.errorCategory ?? null;
  const id = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx
      .insert(turnOutcomes)
      .values({ chunkId, errorCategory, grade: request.grade, id, recordedAt: now, userId });

    if (errorCategory !== null) {
      await tx
        .insert(errorPatterns)
        .values({ category: errorCategory, count: 1, lastSeenAt: now, userId })
        .onConflictDoUpdate({
          set: { count: sql`${errorPatterns.count} + 1`, lastSeenAt: now },
          target: [errorPatterns.userId, errorPatterns.category]
        });
    }
  });

  return { chunkId, errorCategory, grade: request.grade, recordedAt: now.toISOString() };
}

// The signals the rolling profile is distilled from, deterministically.
export type ProfileSignals = Readonly<{
  focus: string;
  level: ProficiencyLevel;
  strengths: ReadonlyArray<string>;
  weaknesses: ReadonlyArray<string>;
}>;

// Phrases the structured signals into the profile's prose summary. Injected so an LLM can phrase it
// later; the default is deterministic, keeping the whole update testable with a fake.
export type ProfilePhraser = (signals: ProfileSignals) => string;

export const defaultProfileSummary: ProfilePhraser = (signals) => {
  const strengths = signals.strengths.length === 0 ? "none yet" : signals.strengths.join(", ");
  const weaknesses =
    signals.weaknesses.length === 0 ? "no recurring errors" : signals.weaknesses.join(", ");
  const focus = signals.focus.length === 0 ? "nothing queued" : signals.focus;
  return `A ${signals.level} learner. Strengths: ${strengths}. Watch: ${weaknesses}. Focus: ${focus}.`;
};

// Count mastered chunks per domain and return the strongest domains (by mastered count) as the
// learner's strengths, capped and stably ordered.
function topStrengths(
  candidates: ReadonlyArray<{ domainName: string; status: string }>
): ReadonlyArray<string> {
  const masteredByDomain = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.status === "mastered") {
      masteredByDomain.set(
        candidate.domainName,
        (masteredByDomain.get(candidate.domainName) ?? 0) + 1
      );
    }
  }

  return [...masteredByDomain.entries()]
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1]
    )
    .slice(0, PROFILE_LIST_LIMIT)
    .map(([domainName]) => domainName);
}

// Recompute and persist the rolling profile from the user's current model: level from overall mastery,
// strengths from the strongest domains, weaknesses from the top error patterns, focus from the #1
// gap x frequency chunk's case. Deterministic; the summary phrasing is delegated to the injected
// phraser.
export async function updateLearnerProfile(
  dependencies: LearnerDependencies,
  userId: string,
  now: Date,
  phraser: ProfilePhraser = defaultProfileSummary
): Promise<LearnerProfileDto> {
  const candidates = await loadChunkCandidates(dependencies.db, userId, now);
  const masteredCount = candidates.filter((candidate) => candidate.status === "mastered").length;
  const masteredFraction = candidates.length === 0 ? 0 : masteredCount / candidates.length;

  const level = deriveLevel(masteredFraction);
  const strengths = topStrengths(candidates);
  const weaknesses = (await listErrorPatterns(dependencies.db, userId, PROFILE_LIST_LIMIT)).map(
    (pattern) => pattern.category
  );
  const focus = rankChunksByGapFrequency(candidates, 1)[0]?.caseId ?? "";
  const summary = phraser({ focus, level, strengths, weaknesses });

  await dependencies.db
    .insert(learnerProfiles)
    .values({
      focus,
      level,
      strengthsJson: strengths,
      summary,
      updatedAt: now,
      userId,
      weaknessesJson: weaknesses
    })
    .onConflictDoUpdate({
      set: {
        focus,
        level,
        strengthsJson: strengths,
        summary,
        updatedAt: now,
        weaknessesJson: weaknesses
      },
      target: learnerProfiles.userId
    });

  return {
    focus,
    level,
    strengths: [...strengths],
    summary,
    updatedAt: now.toISOString(),
    weaknesses: [...weaknesses]
  };
}
