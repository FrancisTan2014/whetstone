import type { AuthoredWorkSummaryDto, LatestReadingPositionDto } from "@whetstone/contracts";
import {
  composeTodayBoard,
  localDayKey,
  recitationTodayRoutineSummary,
  type TodayBoard,
  type TodayInvitationSource,
  type TodayNewPassageSource,
  type TodayRoutineSource
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { getLatestAuthoredWorkInProgress } from "../authoredWorks/authoredWorkQueries.js";
import { loadMemoryRoutineSummary } from "../memory/memoryQueries.js";
import { getLatestReadingPosition } from "../readingPosition/readingPositionQueries.js";
import { loadRecitationSession } from "../recitation/recitationSessionQueries.js";

export type TodayDependencies = Readonly<{ db: DbClient }>;

// The server-composed Today board (#610): a pure read/compose over feature-owned canonical state for the
// learner's local day (#606). Today owns no task or completion rows — it fetches each source guarded by
// its own try/catch so one throwing marks only that source failed (never blanks the board), then folds
// the typed results through the pure `composeTodayBoard` domain function. The board is a
// `TodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>`, structurally the `TodayBoardDto` the
// route validates at the API boundary before sending.
export type TodayBoardResult = TodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>;

const NO_DUE_ROUTINE: TodayRoutineSource = {
  status: "ok",
  summary: { dueCount: 0, nextDueAt: null, overdueCount: 0 }
};

// The Recitation routine (#609) and its "New passage" invitation (#607) both derive from one session
// projection, so one guarded load yields both. A thrown load fails the routine (keeping the board
// un-clear) and quietly fails the invitation; a plan-less learner has no due routine and no invitation.
async function loadRecitationSources(
  dependencies: TodayDependencies,
  userId: string,
  now: Date,
  timeZone: string
): Promise<Readonly<{ newPassage: TodayNewPassageSource; routine: TodayRoutineSource }>> {
  try {
    const session = await loadRecitationSession(dependencies, userId, now, timeZone);
    if (session.status === "no_plan") {
      return { newPassage: { planEntryId: null, status: "ok" }, routine: NO_DUE_ROUTINE };
    }
    return {
      newPassage: {
        planEntryId: session.newPassage.available ? session.planEntryId : null,
        status: "ok"
      },
      routine: {
        status: "ok",
        // A required non-card step (unstarted whole-Work / eligible chain) has no due card, so fold the
        // session step into the summary here — a card-only view would let Today falsely report clear
        // while a real recitation obligation is pending (#610).
        summary: recitationTodayRoutineSummary({
          due: session.due,
          nowIso: now.toISOString(),
          step: session.step
        })
      }
    };
  } catch {
    return { newPassage: { status: "failed" }, routine: { status: "failed" } };
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
  const recitation = await loadRecitationSources(dependencies, userId, now, timeZone);
  const memory = await loadMemorySource(db, userId, now, timeZone);
  const reading = await loadReadingSource(db, userId);
  const writing = await loadWritingSource(db, userId);

  return composeTodayBoard<LatestReadingPositionDto, AuthoredWorkSummaryDto>({
    date: localDayKey(now, timeZone),
    memory,
    newPassage: recitation.newPassage,
    reading,
    recitation: recitation.routine,
    writing
  });
}
