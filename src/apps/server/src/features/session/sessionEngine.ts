import type {
  CoachConverseResult,
  CoachKnobs,
  CoachSayRequest,
  CompiledLearnerContextDto,
  DebriefDto,
  DebriefDueDto,
  SessionPlanDto,
  SubmitTurnRequest,
  TurnResultDto,
  EndSessionRequest
} from "@whetstone/contracts";
import {
  deriveCoachKnobs,
  englishShare,
  mistakeCategoryFromIssues,
  scheduleReview,
  type LearnerSnapshot,
  type ReviewGrade
} from "@whetstone/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { CoachProvider } from "../../coach/coachProvider.js";
import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, sessionExchanges } from "../../db/schema.js";
import { depositTurnOutcome, updateLearnerProfile } from "../learner/learnerCommands.js";
import { compileContext } from "../learner/learnerQueries.js";
import { harvestReadingCase } from "./harvestCommands.js";
import { enrollRecallItem, recordRecallReview } from "../recall/recallCommands.js";
import { getRecallItemByChunkForUser } from "../recall/recallQueries.js";
import type { SpeechInput } from "../../speech/speechInput.js";

// How many cues a session proposes, and the soft per-cue timer (mild time pressure).
const SESSION_SIZE = 5;
const CUE_TIMER_SECONDS = 20;

// Distil the compiled learner context (#208) into the snapshot the pure knobs function reads, then
// derive the adaptive coach knobs (#223). Deterministic; the briefing for the fixed coach skill.
function knobsFromContext(context: CompiledLearnerContextDto): CoachKnobs {
  const snapshot: LearnerSnapshot = {
    band: context.profile?.level ?? "beginner",
    dueChunkCount: context.rankedChunks.length,
    englishShare: context.englishShareTrend ?? 1,
    focus: context.profile?.focus ?? "",
    l1: context.l1 ?? "none",
    recentGrades: context.recentOutcomes.map((outcome) => outcome.grade),
    topErrorPatterns: context.relevantErrors.map((pattern) => pattern.category)
  };
  const knobs = deriveCoachKnobs(snapshot);
  return { ...knobs, probeErrorPatterns: [...knobs.probeErrorPatterns] };
}

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

export type EndRoundOutcome =
  | Readonly<{ debrief: DebriefDto; status: "ok" }>
  | Readonly<{ status: "case_not_found" }>;

// The outcome grade logged for a tagged mistake (a deposited turn outcome feeds the error-pattern store
// and recent-outcomes context). Mistakes are weak production, so a low grade.
const MISTAKE_OUTCOME_GRADE: ReviewGrade = 2;

// Plan a session: the navigation step. The top gap x frequency chunks (#208 — error-weighted, mixing
// new and due) become the cues, each carrying its English situation (never L1) and the native target
// (revealed only in feedback). Empty when there is nothing to practise.
export async function startSession(
  dependencies: SessionDependencies,
  userId: string,
  now: Date
): Promise<SessionPlanDto> {
  // The reading -> speaking on-ramp (#243): a recent reading capture seeds a case whose first cue is
  // that text, so practice opens on what the learner just read; authored cues fill the rest.
  const harvested = await harvestReadingCase(
    { createId: dependencies.createId, db: dependencies.db },
    userId
  );
  const harvestedCue = harvested ? [{ ...harvested, timerSeconds: CUE_TIMER_SECONDS }] : [];

  const context = await compileContext(dependencies.db, userId, now, { chunkLimit: SESSION_SIZE });
  const chunkIds = context.rankedChunks.map((ranked) => ranked.chunkId);
  if (chunkIds.length === 0) {
    return { cues: harvestedCue };
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

  return { cues: [...harvestedCue, ...cues] };
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
    .select({
      situation: cases.situation,
      sourceBlockEntryId: chunks.sourceBlockEntryId,
      target: chunks.text
    })
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
      {
        chunkId: request.chunkId,
        kind: "chunk",
        ...(row.sourceBlockEntryId === null ? {} : { provenanceEntryId: row.sourceBlockEntryId }),
        text: row.target
      },
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
  const knobs = knobsFromContext(await compileContext(dependencies.db, userId, now));
  const reply = await dependencies.coach.converse({
    communicativeFunction: caseRow.communicativeFunction,
    context: { focus: caseRow.situation, recentTargets: [] },
    history,
    knobs,
    situation: caseRow.situation
  });

  await dependencies.db.insert(sessionExchanges).values([
    {
      caseId: request.caseId,
      createdAt: now,
      englishShare: englishShare(request.transcript),
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

// End the round (#222): run ONE analysis pass over the whole round (transcript rebuilt from the
// persisted exchange + STT word-timings + the case's target chunks + compiled context), then DEPOSIT the
// durable trace deterministically — four moves, no extra model calls — and return the compact debrief:
//   1. chunk grades -> SM-2 schedules in the recall store (#188/#189), which also advances case mastery
//      and so the fog-of-war map (#210);
//   2. tagged mistakes -> error-pattern counts in the learner model (#208);
//   3. the rolling profile (#208) recomputed.
// Grading happens only here, never per live turn.
export async function endSession(
  dependencies: SessionDependencies,
  request: EndSessionRequest,
  userId: string,
  now: Date
): Promise<EndRoundOutcome> {
  const caseRows = await dependencies.db
    .select({ communicativeFunction: cases.communicativeFunction, situation: cases.situation })
    .from(cases)
    .where(eq(cases.id, request.caseId))
    .limit(1);
  const caseRow = caseRows[0];
  if (caseRow === undefined) {
    return { status: "case_not_found" };
  }

  const targetChunks = await dependencies.db
    .select({
      chunkId: chunks.id,
      sourceBlockEntryId: chunks.sourceBlockEntryId,
      text: chunks.text
    })
    .from(chunks)
    .where(eq(chunks.caseId, request.caseId))
    .orderBy(asc(chunks.orderIndex), asc(chunks.id));

  const history = await dependencies.db
    .select({ role: sessionExchanges.role, text: sessionExchanges.text })
    .from(sessionExchanges)
    .where(and(eq(sessionExchanges.userId, userId), eq(sessionExchanges.caseId, request.caseId)))
    .orderBy(asc(sessionExchanges.orderIndex));

  const context = await compileContext(dependencies.db, userId, now);
  const analysis = await dependencies.coach.analyze({
    communicativeFunction: caseRow.communicativeFunction,
    context,
    history,
    knobs: knobsFromContext(context),
    situation: caseRow.situation,
    targetChunks,
    words: [...request.words]
  });

  const learnerDeps = { createId: dependencies.createId, db: dependencies.db };
  const textByChunkId = new Map(targetChunks.map((chunk) => [chunk.chunkId, chunk.text]));
  const blockByChunkId = new Map(
    targetChunks.map((chunk) => [chunk.chunkId, chunk.sourceBlockEntryId])
  );

  // Deposit 1: each chunk grade schedules its recall item (enrolling on first practice), which advances
  // case mastery and the map.
  const due: DebriefDueDto[] = [];
  for (const chunkGrade of analysis.chunkGrades) {
    const { chunkId } = chunkGrade;
    // Only chunks that were part of this round can be deposited (their text + FK exist); a grade for any
    // other chunk is ignored rather than enrolling a dangling recall item.
    const text = textByChunkId.get(chunkId);
    if (text === undefined) {
      continue;
    }
    const sourceBlock = blockByChunkId.get(chunkId);
    // The schema bounds grade to an integer 0..5, the SM-2 ReviewGrade range.
    const grade = chunkGrade.grade as ReviewGrade;
    const existing = await getRecallItemByChunkForUser(dependencies.db, userId, chunkId);
    const item =
      existing ??
      (await enrollRecallItem(
        learnerDeps,
        {
          chunkId,
          kind: "chunk",
          ...(sourceBlock ? { provenanceEntryId: sourceBlock } : {}),
          text
        },
        userId,
        now
      ));
    const dueAt = scheduleReview(item.review, grade, now).dueAt;
    await recordRecallReview(learnerDeps, item.id, grade, userId, now);
    due.push({ dueAt, text });
  }

  // Deposit 2: each tagged mistake increments its error-pattern count and logs an outcome.
  for (const mistake of analysis.mistakes) {
    await depositTurnOutcome(
      learnerDeps,
      { chunkId: null, errorCategory: mistake.category, grade: MISTAKE_OUTCOME_GRADE },
      userId,
      now
    );
  }

  // Deposit 3: recompute the rolling profile from the updated model.
  await updateLearnerProfile(learnerDeps, userId, now);

  return {
    debrief: {
      due,
      encouragement: analysis.encouragement,
      moments: analysis.mistakes.map((mistake) => ({
        native: mistake.native,
        said: mistake.said,
        why: mistake.why
      })),
      upgrade: analysis.upgrade,
      wins: [...analysis.wins]
    },
    status: "ok"
  };
}
