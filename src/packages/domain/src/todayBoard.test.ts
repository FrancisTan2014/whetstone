import { describe, expect, it } from "vitest";

import {
  compareRoutines,
  composeTodayBoard,
  type ComposeTodayBoardInput,
  type TodayRoutineComposition,
  type TodayRoutineSource
} from "./todayBoard.js";

type Position = Readonly<{ workEntryId: string }>;
type Work = Readonly<{ entryId: string }>;

const clearRoutine: TodayRoutineSource = {
  status: "ok",
  summary: { dueCount: 0, nextDueAt: null, nextReviewAt: null, overdueCount: 0 }
};

// A clear routine that still has a future scheduled review — the shape that lets a clear board report
// its next known due time.
function clearWithNextReview(nextReviewAt: string): TodayRoutineSource {
  return { status: "ok", summary: { dueCount: 0, nextDueAt: null, nextReviewAt, overdueCount: 0 } };
}

function dueRoutine(nextDueAt: string, overdueCount: number, dueCount = 2): TodayRoutineSource {
  return {
    status: "ok",
    summary: { dueCount, nextDueAt, nextReviewAt: null, overdueCount }
  };
}

function baseInput(
  overrides: Partial<ComposeTodayBoardInput<Position, Work>> = {}
): ComposeTodayBoardInput<Position, Work> {
  return {
    date: "2026-07-15",
    memory: clearRoutine,
    reading: { status: "ok", value: null },
    recitation: clearRoutine,
    writing: { status: "ok", value: null },
    ...overrides
  };
}

describe("composeTodayBoard", () => {
  it("is clear when nothing is due and no routine failed", () => {
    const board = composeTodayBoard(baseInput());

    expect(board.date).toBe("2026-07-15");
    expect(board.dueNow).toEqual([]);
    expect(board.routineFailures).toEqual([]);
    expect(board.clear).toBe(true);
  });

  it("excludes a paused or zero-due routine from Due now", () => {
    const board = composeTodayBoard(baseInput({ recitation: clearRoutine, memory: clearRoutine }));

    expect(board.dueNow).toEqual([]);
    expect(board.clear).toBe(true);
  });

  it("groups a due routine into one row with overdue emphasis and is not clear", () => {
    const board = composeTodayBoard(
      baseInput({ memory: dueRoutine("2026-07-15T08:00:00.000Z", 1, 3) })
    );

    expect(board.dueNow).toEqual([
      {
        dueCount: 3,
        kind: "memory",
        nextDueAt: "2026-07-15T08:00:00.000Z",
        overdue: true,
        overdueCount: 1
      }
    ]);
    expect(board.clear).toBe(false);
  });

  it("marks a due routine with no overdue cards as not overdue", () => {
    const board = composeTodayBoard(
      baseInput({ recitation: dueRoutine("2026-07-15T08:00:00.000Z", 0) })
    );

    expect(board.dueNow[0]?.overdue).toBe(false);
  });

  it("orders an overdue routine before an earlier-but-not-overdue routine", () => {
    const board = composeTodayBoard(
      baseInput({
        memory: dueRoutine("2026-07-15T06:00:00.000Z", 0),
        recitation: dueRoutine("2026-07-15T09:00:00.000Z", 1)
      })
    );

    expect(board.dueNow.map((routine) => routine.kind)).toEqual(["recitation", "memory"]);
  });

  it("orders by earliest nextDueAt when overdue status is equal", () => {
    const board = composeTodayBoard(
      baseInput({
        memory: dueRoutine("2026-07-15T06:00:00.000Z", 0),
        recitation: dueRoutine("2026-07-15T09:00:00.000Z", 0)
      })
    );

    expect(board.dueNow.map((routine) => routine.kind)).toEqual(["memory", "recitation"]);
  });

  it("tie-breaks equal overdue and nextDueAt with Recitation first", () => {
    const at = "2026-07-15T09:00:00.000Z";
    const board = composeTodayBoard(
      baseInput({ memory: dueRoutine(at, 1), recitation: dueRoutine(at, 1) })
    );

    expect(board.dueNow.map((routine) => routine.kind)).toEqual(["recitation", "memory"]);
  });

  it("reports the earliest future scheduled review across both sources as nextReviewAt", () => {
    const board = composeTodayBoard(
      baseInput({
        memory: clearWithNextReview("2026-07-20T00:00:00.000Z"),
        recitation: clearWithNextReview("2026-07-18T00:00:00.000Z")
      })
    );

    expect(board.clear).toBe(true);
    expect(board.nextReviewAt).toBe("2026-07-18T00:00:00.000Z");
  });

  it("reports a single source's future review when the other is enrolled with none ahead", () => {
    const board = composeTodayBoard(
      baseInput({
        memory: clearRoutine,
        recitation: clearWithNextReview("2026-07-18T00:00:00.000Z")
      })
    );

    expect(board.nextReviewAt).toBe("2026-07-18T00:00:00.000Z");
  });

  it("leaves nextReviewAt null when nothing is enrolled ahead", () => {
    const board = composeTodayBoard(baseInput());

    expect(board.nextReviewAt).toBeNull();
  });

  it("never reports nextReviewAt from a failed source", () => {
    const board = composeTodayBoard(
      baseInput({
        memory: { status: "failed" },
        recitation: clearWithNextReview("2026-07-18T00:00:00.000Z")
      })
    );

    // The one loaded source still contributes its future review; the failed one cannot claim a time.
    expect(board.nextReviewAt).toBe("2026-07-18T00:00:00.000Z");
    expect(board.routineFailures).toEqual(["memory"]);
  });

  it("records a failed routine and stays un-clear even with nothing due", () => {
    const board = composeTodayBoard(baseInput({ recitation: { status: "failed" } }));

    expect(board.dueNow).toEqual([]);
    expect(board.routineFailures).toEqual(["recitation"]);
    expect(board.clear).toBe(false);
  });

  it("records both routines when both fail", () => {
    const board = composeTodayBoard(
      baseInput({ recitation: { status: "failed" }, memory: { status: "failed" } })
    );

    expect(board.routineFailures).toEqual(["recitation", "memory"]);
    expect(board.clear).toBe(false);
  });

  it("maps the reading invitation to ready, empty, and failed", () => {
    expect(
      composeTodayBoard(baseInput({ reading: { status: "ok", value: { workEntryId: "w1" } } }))
        .continueReading
    ).toEqual({ position: { workEntryId: "w1" }, status: "ready" });
    expect(
      composeTodayBoard(baseInput({ reading: { status: "ok", value: null } })).continueReading
    ).toEqual({ status: "empty" });
    expect(composeTodayBoard(baseInput({ reading: { status: "failed" } })).continueReading).toEqual(
      {
        status: "failed"
      }
    );
  });

  it("maps the writing invitation to ready, empty, and failed", () => {
    expect(
      composeTodayBoard(baseInput({ writing: { status: "ok", value: { entryId: "work-1" } } }))
        .continueWriting
    ).toEqual({ status: "ready", work: { entryId: "work-1" } });
    expect(
      composeTodayBoard(baseInput({ writing: { status: "ok", value: null } })).continueWriting
    ).toEqual({ status: "empty" });
    expect(composeTodayBoard(baseInput({ writing: { status: "failed" } })).continueWriting).toEqual(
      {
        status: "failed"
      }
    );
  });
});

describe("compareRoutines", () => {
  function routine(over: Partial<TodayRoutineComposition> = {}): TodayRoutineComposition {
    return {
      dueCount: 1,
      kind: "memory",
      nextDueAt: "2026-07-15T09:00:00.000Z",
      overdue: false,
      overdueCount: 0,
      ...over
    };
  }

  it("orders an overdue routine before a not-overdue one in either argument order", () => {
    const overdue = routine({ kind: "recitation", overdue: true });
    const onTime = routine({ kind: "memory", overdue: false });

    expect(compareRoutines(overdue, onTime)).toBeLessThan(0);
    expect(compareRoutines(onTime, overdue)).toBeGreaterThan(0);
  });

  it("orders by earliest nextDueAt when overdue status matches, in either argument order", () => {
    const earlier = routine({ kind: "memory", nextDueAt: "2026-07-15T06:00:00.000Z" });
    const later = routine({ kind: "recitation", nextDueAt: "2026-07-15T09:00:00.000Z" });

    expect(compareRoutines(earlier, later)).toBeLessThan(0);
    expect(compareRoutines(later, earlier)).toBeGreaterThan(0);
  });

  it("tie-breaks equal overdue and nextDueAt with Recitation first, in either argument order", () => {
    const memory = routine({ kind: "memory" });
    const recitation = routine({ kind: "recitation" });

    expect(compareRoutines(recitation, memory)).toBeLessThan(0);
    expect(compareRoutines(memory, recitation)).toBeGreaterThan(0);
  });
});
