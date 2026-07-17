import { describe, expect, it, beforeEach } from "vitest";

import { createTextDocument } from "@whetstone/document";

import {
  clearDiarySession,
  diaryScrollTop,
  diaryTimelineSnapshot,
  rememberDiaryScrollTop,
  rememberDiaryTimeline,
  type DiaryTimelineSnapshot
} from "./diarySessionStore";

const snapshot: DiaryTimelineSnapshot = {
  cursor: "2026-06-22",
  entries: [
    {
      bodyDoc: createTextDocument("a remembered thought"),
      bodyText: "a remembered thought",
      date: "2026-06-28",
      entryId: "r28",
      kind: "diary",
      language: null,
      occurredAt: "2026-06-28T08:00:00.000Z"
    }
  ],
  hasMore: true
};

beforeEach(() => {
  clearDiarySession();
});

describe("diarySessionStore", () => {
  it("starts empty at the top of a session", () => {
    expect(diaryTimelineSnapshot()).toBeNull();
    expect(diaryScrollTop()).toBe(0);
  });

  it("remembers and returns the loaded timeline and scroll offset", () => {
    rememberDiaryTimeline(snapshot);
    rememberDiaryScrollTop(240);

    expect(diaryTimelineSnapshot()).toEqual(snapshot);
    expect(diaryScrollTop()).toBe(240);
  });

  it("forgets the remembered place when cleared", () => {
    rememberDiaryTimeline(snapshot);
    rememberDiaryScrollTop(240);

    clearDiarySession();

    expect(diaryTimelineSnapshot()).toBeNull();
    expect(diaryScrollTop()).toBe(0);
  });
});
