import type {
  CompiledLearnerContextDto,
  ErrorPatternDto,
  LearnerProfileDto,
  RankedChunkDto,
  TurnOutcomeDto
} from "@whetstone/contracts";
import {
  chunkMasteryStatus,
  rankChunksByGapFrequency,
  type ChunkMasteryStatus,
  type ReviewState
} from "@whetstone/domain";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  cases,
  chunks,
  domains,
  errorPatterns,
  learnerProfiles,
  recallItems,
  turnOutcomes
} from "../../db/schema.js";
import { rowToReviewState } from "../recall/recallQueries.js";

// The bounded slice compiled for each coaching call stays roughly constant in size regardless of
// history: the top gap x frequency chunks, the most frequent/recent errors, and the most recent
// outcomes are each capped here.
export const DEFAULT_CHUNK_LIMIT = 10;
export const DEFAULT_ERROR_LIMIT = 5;
export const DEFAULT_OUTCOME_LIMIT = 10;

// A candidate chunk enriched with its domain name (for profile strengths), on top of the fields the
// pure ranker needs.
export type EnrichedCandidate = Readonly<{
  caseId: string;
  chunkId: string;
  domainId: string;
  domainName: string;
  frequency: number;
  status: ChunkMasteryStatus;
}>;

// Group the user's recall review states by the chunk each item is linked to. Only the user's own items
// are read, so one user's progress never leaks into another's model.
async function reviewStatesByChunkId(
  db: DbClient,
  userId: string
): Promise<Map<string, ReviewState[]>> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), isNotNull(recallItems.chunkId)));

  const byChunk = new Map<string, ReviewState[]>();
  for (const row of rows) {
    // `chunkId` is non-null here: the `isNotNull` filter only matches linked items.
    const chunkId = row.chunkId as string;
    const states = byChunk.get(chunkId) ?? [];
    states.push(rowToReviewState(row));
    byChunk.set(chunkId, states);
  }

  return byChunk;
}

// Load every corpus chunk with its domain's frequency weight and the user's current mastery status for
// it. The corpus is bounded, so this is constant in the learner's history.
export async function loadChunkCandidates(
  db: DbClient,
  userId: string,
  now: Date
): Promise<ReadonlyArray<EnrichedCandidate>> {
  const chunkRows = await db
    .select({
      caseId: chunks.caseId,
      chunkId: chunks.id,
      domainId: cases.domainId,
      domainName: domains.name,
      frequency: domains.weight
    })
    .from(chunks)
    .innerJoin(cases, eq(chunks.caseId, cases.id))
    .innerJoin(domains, eq(cases.domainId, domains.id));

  const statesByChunkId = await reviewStatesByChunkId(db, userId);

  return chunkRows.map((row) => ({
    ...row,
    status: chunkMasteryStatus(statesByChunkId.get(row.chunkId) ?? [], now)
  }));
}

function toErrorPatternDto(row: typeof errorPatterns.$inferSelect): ErrorPatternDto {
  return { category: row.category, count: row.count, lastSeenAt: row.lastSeenAt.toISOString() };
}

// The user's error patterns, most frequent (then most recent) first, capped at `limit`.
export async function listErrorPatterns(
  db: DbClient,
  userId: string,
  limit: number
): Promise<ReadonlyArray<ErrorPatternDto>> {
  const rows = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.userId, userId))
    .orderBy(desc(errorPatterns.count), desc(errorPatterns.lastSeenAt), asc(errorPatterns.category))
    .limit(limit);

  return rows.map(toErrorPatternDto);
}

function toTurnOutcomeDto(row: typeof turnOutcomes.$inferSelect): TurnOutcomeDto {
  return {
    chunkId: row.chunkId,
    errorCategory: row.errorCategory,
    grade: row.grade,
    recordedAt: row.recordedAt.toISOString()
  };
}

// The user's most recent deposited outcomes, newest first, capped at `limit`.
export async function listRecentOutcomes(
  db: DbClient,
  userId: string,
  limit: number
): Promise<ReadonlyArray<TurnOutcomeDto>> {
  const rows = await db
    .select()
    .from(turnOutcomes)
    .where(eq(turnOutcomes.userId, userId))
    .orderBy(desc(turnOutcomes.recordedAt), desc(turnOutcomes.id))
    .limit(limit);

  return rows.map(toTurnOutcomeDto);
}

function toLearnerProfileDto(row: typeof learnerProfiles.$inferSelect): LearnerProfileDto {
  return {
    focus: row.focus,
    level: row.level,
    strengths: row.strengthsJson as string[],
    summary: row.summary,
    updatedAt: row.updatedAt.toISOString(),
    weaknesses: row.weaknessesJson as string[]
  };
}

export async function getLearnerProfile(
  db: DbClient,
  userId: string
): Promise<LearnerProfileDto | undefined> {
  const rows = await db
    .select()
    .from(learnerProfiles)
    .where(eq(learnerProfiles.userId, userId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toLearnerProfileDto(row);
}

export type CompileContextOptions = Readonly<{
  chunkLimit?: number;
  errorLimit?: number;
  outcomeLimit?: number;
}>;

// Assemble the bounded context for a coaching call: the rolling profile, the top gap x frequency
// chunks, the relevant errors, and the recent outcomes. Each list is capped, so the slice is roughly
// constant in size however large the history grows.
export async function compileContext(
  db: DbClient,
  userId: string,
  now: Date,
  options: CompileContextOptions = {}
): Promise<CompiledLearnerContextDto> {
  const chunkLimit = options.chunkLimit ?? DEFAULT_CHUNK_LIMIT;
  const errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
  const outcomeLimit = options.outcomeLimit ?? DEFAULT_OUTCOME_LIMIT;

  const candidates = await loadChunkCandidates(db, userId, now);
  const rankedChunks: ReadonlyArray<RankedChunkDto> = rankChunksByGapFrequency(
    candidates,
    chunkLimit
  );

  return {
    profile: (await getLearnerProfile(db, userId)) ?? null,
    rankedChunks: [...rankedChunks],
    recentOutcomes: [...(await listRecentOutcomes(db, userId, outcomeLimit))],
    relevantErrors: [...(await listErrorPatterns(db, userId, errorLimit))]
  };
}
