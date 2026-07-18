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
  nextReviewAt: null,
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

  it("accepts an ISO nextReviewAt for a clear board's next known due time", () => {
    const parsed = todayBoardDtoSchema.parse({
      ...board,
      nextReviewAt: "2026-07-20T00:00:00.000Z"
    });
    expect(parsed.nextReviewAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("rejects a non-ISO nextReviewAt", () => {
    expect(() => todayBoardDtoSchema.parse({ ...board, nextReviewAt: "someday" })).toThrow();
  });

  it("accepts the failed invitation variants", () => {
    const parsed = todayBoardDtoSchema.parse({
      ...board,
      continueReading: { status: "failed" },
      continueWriting: { status: "failed" }
    });
    expect(parsed.continueReading.status).toBe("failed");
    expect(parsed.continueWriting.status).toBe("failed");
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
