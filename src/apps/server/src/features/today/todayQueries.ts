import type { AuthoredWorkSummaryDto, LatestReadingPositionDto } from "@whetstone/contracts";
import {
  composeTodayBoard,
  localDayKey,
  type TodayBoard,
  type TodayInvitationSource,
  type TodayRoutineSource
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { getLatestAuthoredWorkInProgress } from "../authoredWorks/authoredWorkQueries.js";
import { loadMemoryRoutineSummary } from "../memory/memoryQueries.js";
import { getLatestReadingPosition } from "../readingPosition/readingPositionQueries.js";
import { loadRecitationRoutineSummary } from "../recitation/recitationReviewQueries.js";

export type TodayDependencies = Readonly<{ db: DbClient }>;

// The server-composed Today board (#610): a pure read/compose over feature-owned canonical state for the
// learner's local day (#606). Today owns no task or completion rows — it fetches each source guarded by
// its own try/catch so one throwing marks only that source failed (never blanks the board), then folds
// the typed results through the pure `composeTodayBoard` domain function. The board is a
// `TodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>`, structurally the `TodayBoardDto` the
// route validates at the API boundary before sending.
export type TodayBoardResult = TodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>;

// The Recitation routine (#643): its due state derives ONLY from the learner's Work-level maintenance
// review cards, aggregated across every unpaused plan (#633). Passage/chain/introduction/ownership state
// no longer contributes, so a plan with no due Work-level card never blocks Today from becoming clear. A
// thrown load fails the routine (keeping the board un-clear rather than falsely clear).
async function loadRecitationSource(
  db: DbClient,
  userId: string,
  now: Date,
  timeZone: string
): Promise<TodayRoutineSource> {
  try {
    return {
      status: "ok",
      summary: await loadRecitationRoutineSummary({ db }, userId, now, timeZone)
    };
  } catch {
    return { status: "failed" };
  }
}

async function loadMemorySource(
  db: DbClient,
  userId: string,
  now: Date,
  timeZone: string
): Promise<TodayRoutineSource> {
  try {
    return { status: "ok", summary: await loadMemoryRoutineSummary(db, userId, now, timeZone) };
  } catch {
    return { status: "failed" };
  }
}

async function loadReadingSource(
  db: DbClient,
  userId: string
): Promise<TodayInvitationSource<LatestReadingPositionDto>> {
  try {
    const position = await getLatestReadingPosition(db, userId);
    return { status: "ok", value: position ?? null };
  } catch {
    return { status: "failed" };
  }
}

async function loadWritingSource(
  db: DbClient,
  userId: string
): Promise<TodayInvitationSource<AuthoredWorkSummaryDto>> {
  try {
    return { status: "ok", value: await getLatestAuthoredWorkInProgress(db, userId) };
  } catch {
    return { status: "failed" };
  }
}

export async function loadTodayBoard(
  dependencies: TodayDependencies,
  userId: string,
  now: Date,
  timeZone: string
): Promise<TodayBoardResult> {
  const { db } = dependencies;
  const recitation = await loadRecitationSource(db, userId, now, timeZone);
  const memory = await loadMemorySource(db, userId, now, timeZone);
  const reading = await loadReadingSource(db, userId);
  const writing = await loadWritingSource(db, userId);

  return composeTodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>({
    date: localDayKey(now, timeZone),
    memory,
    reading,
    recitation,
    writing
  });
}
