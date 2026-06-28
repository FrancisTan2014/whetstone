import type {
  CoachConverseResult,
  CoachSayRequest,
  SessionPlanDto,
  SessionSummaryDto,
  SubmitTurnRequest,
  TurnResultDto,
  EndSessionRequest
} from "@whetstone/contracts";
import {
  mistakeCategoryFromIssues,
  scheduleReview,
  summarizeSessionTurns,
  type SessionTurn
} from "@whetstone/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { CoachProvider } from "../../coach/coachProvider.js";
import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, sessionExchanges, sessionSummaries } from "../../db/schema.js";
import { depositTurnOutcome, updateLearnerProfile } from "../learner/learnerCommands.js";
import { compileContext } from "../learner/learnerQueries.js";
import { enrollRecallItem, recordRecallReview } from "../recall/recallCommands.js";
import { getRecallItemByChunkForUser } from "../recall/recallQueries.js";
import type { SpeechInput } from "../../speech/speechInput.js";

// How many cues a session proposes, and the soft per-cue timer (mild time pressure).
const SESSION_SIZE = 5;
const CUE_TIMER_SECONDS = 20;

export type SessionDependencies = Readonly<{
  coach: CoachProvider;
  createId: () => string;
  db: DbClient;
  now: () => Date;
  // Persist a recorded audio upload and return a path the speech seam can read.
  saveAudio: (audio: Buffer) => Promise<string>;
  speech: SpeechInput;
}>;

export type SubmitTurnOutcome =
  | Readonly<{ result: TurnResultDto; status: "ok" }>
  | Readonly<{ status: "chunk_not_found" }>;

export type ConverseOutcome =
  | Readonly<{ reply: CoachConverseResult; status: "ok" }>
  | Readonly<{ status: "case_not_found" }>;

// Plan a session: the navigation step. The top gap x frequency chunks (#208 — error-weighted, mixing
// new and due) become the cues, each carrying its English situation (never L1) and the native target
// (revealed only in feedback). Empty when there is nothing to practise.
export async function startSession(
  dependencies: SessionDependencies,
  userId: string,
  now: Date
): Promise<SessionPlanDto> {
  const context = await compileContext(dependencies.db, userId, now, { chunkLimit: SESSION_SIZE });
  const chunkIds = context.rankedChunks.map((ranked) => ranked.chunkId);
  if (chunkIds.length === 0) {
    return { cues: [] };
  }

  const rows = await dependencies.db
    .select({
      caseId: cases.id,
      chunkId: chunks.id,
      communicativeFunction: cases.communicativeFunction,
      situation: cases.situation,
      target: chunks.text
    })
    .from(chunks)
    .innerJoin(cases, eq(chunks.caseId, cases.id))
    .where(inArray(chunks.id, chunkIds))
    .orderBy(asc(chunks.orderIndex), asc(chunks.id));

  const cues = rows.map((row) => ({
    caseId: row.caseId,
    chunkId: row.chunkId,
    communicativeFunction: row.communicativeFunction,
    situation: row.situation,
    target: row.target,
    timerSeconds: CUE_TIMER_SECONDS
  }));

  return { cues };
}

// Run one turn: transcribe the production (STT seam, or the typed fallback), judge + grade it (#206),
// and DEPOSIT the attempt — schedule the chunk's recall item (#188/#189, enrolling it on first
// practice) and record the turn outcome with its mistake category (#208). Returns the compact feedback.
export async function submitTurn(
  dependencies: SessionDependencies,
  request: SubmitTurnRequest,
  userId: string,
  now: Date
): Promise<SubmitTurnOutcome> {
  const rows = await dependencies.db
    .select({ situation: cases.situation, target: chunks.text })
    .from(chunks)
    .innerJoin(cases, eq(chunks.caseId, cases.id))
    .where(eq(chunks.id, request.chunkId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { status: "chunk_not_found" };
  }

  const transcript = request.transcript;

  const judgement = await dependencies.coach.judgeProduction({
    context: { focus: row.situation, recentTargets: [] },
    target: row.target,
    transcript
  });
  const grade = dependencies.coach.gradeForScheduler(judgement);
  const errorCategory = mistakeCategoryFromIssues(judgement.issues);

  const recallDeps = { createId: dependencies.createId, db: dependencies.db };
  const existing = await getRecallItemByChunkForUser(dependencies.db, userId, request.chunkId);
  const item =
    existing ??
    (await enrollRecallItem(
      recallDeps,
      { chunkId: request.chunkId, kind: "chunk", text: row.target },
      userId,
      now
    ));

  const nextDueAt = scheduleReview(item.review, grade, now).dueAt;
  await recordRecallReview(recallDeps, item.id, grade, userId, now);
  await depositTurnOutcome(
    recallDeps,
    { chunkId: request.chunkId, errorCategory, grade },
    userId,
    now
  );

  return {
    result: { errorCategory, grade, judgement, nextDueAt, target: row.target, transcript },
    status: "ok"
  };
}

// One conversational coach turn (#220): the live call loop's per-turn call. Load the case the call is
// set in, rebuild the conversation so far from the persisted exchange, append the learner's latest
// transcript, and ask the coach for its next spoken line (+ light repair only on a real breakdown). The
// learner turn and the coach reply are persisted so the next call can rebuild the history. No grading or
// recall deposit happens here — that is the end-of-round job (#222); the coach stays in flow.
export async function converseTurn(
  dependencies: SessionDependencies,
  request: CoachSayRequest,
  userId: string,
  now: Date
): Promise<ConverseOutcome> {
  const caseRows = await dependencies.db
    .select({ communicativeFunction: cases.communicativeFunction, situation: cases.situation })
    .from(cases)
    .where(eq(cases.id, request.caseId))
    .limit(1);
  const caseRow = caseRows[0];
  if (caseRow === undefined) {
    return { status: "case_not_found" };
  }

  const prior = await dependencies.db
    .select({ role: sessionExchanges.role, text: sessionExchanges.text })
    .from(sessionExchanges)
    .where(and(eq(sessionExchanges.userId, userId), eq(sessionExchanges.caseId, request.caseId)))
    .orderBy(asc(sessionExchanges.orderIndex));

  const history = [...prior, { role: "user" as const, text: request.transcript }];
  const reply = await dependencies.coach.converse({
    communicativeFunction: caseRow.communicativeFunction,
    context: { focus: caseRow.situation, recentTargets: [] },
    history,
    situation: caseRow.situation
  });

  await dependencies.db.insert(sessionExchanges).values([
    {
      caseId: request.caseId,
      createdAt: now,
      id: dependencies.createId(),
      orderIndex: prior.length,
      repairJson: null,
      role: "user",
      text: request.transcript,
      userId
    },
    {
      caseId: request.caseId,
      createdAt: now,
      id: dependencies.createId(),
      orderIndex: prior.length + 1,
      repairJson: reply.repair ?? null,
      role: "coach",
      text: reply.say,
      userId
    }
  ]);

  return { reply, status: "ok" };
}

// End the session: aggregate the reported turns into a summary, persist it, and refresh the rolling
// profile (#208) so tomorrow's navigation reflects today's practice — the compounding loop closing.
export async function endSession(
  dependencies: SessionDependencies,
  request: EndSessionRequest,
  userId: string,
  now: Date
): Promise<SessionSummaryDto> {
  const turns: ReadonlyArray<SessionTurn> = request.turns.map((turn) => ({
    errorCategory: turn.errorCategory,
    grade: turn.grade
  }));
  const summary = summarizeSessionTurns(turns);

  await dependencies.db.insert(sessionSummaries).values({
    averageGrade: summary.averageGrade,
    createdAt: now,
    errorCountsJson: summary.errorCounts,
    id: dependencies.createId(),
    strongTurns: summary.strongTurns,
    turnCount: summary.turnCount,
    userId
  });
  await updateLearnerProfile({ createId: dependencies.createId, db: dependencies.db }, userId, now);

  return { ...summary, errorCounts: [...summary.errorCounts] };
}
