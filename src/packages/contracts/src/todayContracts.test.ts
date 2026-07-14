import { describe, expect, it } from "vitest";

import {
  parseTodayBoardResponse,
  todayBoardDtoSchema,
  todayRoutineDtoSchema
} from "./todayContracts.js";

const routine = {
  dueCount: 2,
  kind: "recitation",
  nextDueAt: "2026-07-15T00:00:00.000Z",
  overdue: true,
  overdueCount: 1
} as const;

const board = {
  clear: false,
  continueReading: {
    position: {
      anchorBlockEntryId: null,
      unitEntryId: "unit-1",
      workEntryId: "work-1",
      workTitle: "Fables"
    },
    status: "ready"
  },
  continueWriting: { status: "empty" },
  date: "2026-07-15",
  dueNow: [routine],
  newPassage: { planEntryId: "plan-1", status: "available" },
  routineFailures: ["memory"]
} as const;

describe("todayRoutineDtoSchema", () => {
  it("accepts a fully-specified due routine", () => {
    expect(todayRoutineDtoSchema.parse(routine)).toEqual(routine);
  });

  it("rejects a non-positive due count", () => {
    expect(() => todayRoutineDtoSchema.parse({ ...routine, dueCount: 0 })).toThrow();
  });

  it("rejects an unknown routine kind", () => {
    expect(() => todayRoutineDtoSchema.parse({ ...routine, kind: "reading" })).toThrow();
  });

  it("rejects a non-ISO nextDueAt", () => {
    expect(() => todayRoutineDtoSchema.parse({ ...routine, nextDueAt: "soon" })).toThrow();
  });
});

describe("todayBoardDtoSchema", () => {
  it("accepts a fully-specified board", () => {
    expect(todayBoardDtoSchema.parse(board)).toEqual(board);
  });

  it("accepts the failed and unavailable invitation variants", () => {
    const parsed = todayBoardDtoSchema.parse({
      ...board,
      continueReading: { status: "failed" },
      continueWriting: { status: "failed" },
      newPassage: { status: "unavailable" }
    });
    expect(parsed.continueReading.status).toBe("failed");
    expect(parsed.newPassage.status).toBe("unavailable");
  });

  it("rejects an available new passage missing its plan", () => {
    expect(() =>
      todayBoardDtoSchema.parse({ ...board, newPassage: { status: "available" } })
    ).toThrow();
  });

  it("rejects unknown extra keys", () => {
    expect(() => todayBoardDtoSchema.parse({ ...board, extra: true })).toThrow();
  });
});

describe("parseTodayBoardResponse", () => {
  it("parses a valid response envelope", () => {
    expect(parseTodayBoardResponse({ board })).toEqual({ board });
  });

  it("rejects a response missing the board", () => {
    expect(() => parseTodayBoardResponse({})).toThrow();
  });
});
