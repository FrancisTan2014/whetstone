// Pure aggregation of a finished practice session's turns into its summary: turn count, average grade,
// how many were strong, and the error categories that recurred. No persistence or I/O — the engine
// feeds in the turn grades/categories it deposited and persists the result.

import type { ErrorCategory } from "./learnerModel.js";

export type SessionTurn = Readonly<{
  errorCategory: ErrorCategory | null;
  grade: number;
}>;

export type SessionErrorCount = Readonly<{
  category: ErrorCategory;
  count: number;
}>;

export type SessionSummary = Readonly<{
  averageGrade: number;
  errorCounts: ReadonlyArray<SessionErrorCount>;
  strongTurns: number;
  turnCount: number;
}>;

// A turn graded at least this is "strong" (SM-2 4 = a good recall).
const STRONG_GRADE = 4;

export function summarizeSessionTurns(turns: ReadonlyArray<SessionTurn>): SessionSummary {
  const turnCount = turns.length;
  const totalGrade = turns.reduce((sum, turn) => sum + turn.grade, 0);
  const averageGrade = turnCount === 0 ? 0 : totalGrade / turnCount;
  const strongTurns = turns.filter((turn) => turn.grade >= STRONG_GRADE).length;

  const counts = new Map<ErrorCategory, number>();
  for (const turn of turns) {
    if (turn.errorCategory !== null) {
      counts.set(turn.errorCategory, (counts.get(turn.errorCategory) ?? 0) + 1);
    }
  }

  const errorCounts = [...counts.entries()]
    .sort((left, right) =>
      right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1]
    )
    .map(([category, count]) => ({ category, count }));

  return { averageGrade, errorCounts, strongTurns, turnCount };
}
