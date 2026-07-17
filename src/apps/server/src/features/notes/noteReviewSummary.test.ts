import { describe, expect, it } from "vitest";

import { summarizeNoteReview } from "./noteQueries.js";

const now = new Date("2026-07-11T12:00:00.000Z");

function card(status: "active" | "paused", dueIso: string) {
  return { dueAt: new Date(dueIso), noteEntryId: "note-1", status } as const;
}

describe("summarizeNoteReview", () => {
  it("rolls up a note with no cards as not_enrolled", () => {
    expect(summarizeNoteReview([], now)).toEqual({ status: "not_enrolled" });
  });

  it("counts every active card due at or before now as due", () => {
    const summary = summarizeNoteReview(
      [
        card("active", "2026-07-11T12:00:00.000Z"),
        card("active", "2026-07-10T00:00:00.000Z"),
        card("active", "2026-08-01T00:00:00.000Z")
      ],
      now
    );

    expect(summary).toEqual({ status: "due", dueCount: 2 });
  });

  it("takes due precedence over a paused card", () => {
    expect(
      summarizeNoteReview(
        [card("active", "2026-07-10T00:00:00.000Z"), card("paused", "2026-07-09T00:00:00.000Z")],
        now
      )
    ).toEqual({ status: "due", dueCount: 1 });
  });

  it("schedules to the earliest active future card when nothing is due", () => {
    // Three active future cards, unordered, so the earliest-picking reduce exercises both the "this card
    // is sooner" and the "keep the running soonest" branches.
    const summary = summarizeNoteReview(
      [
        card("active", "2026-08-10T00:00:00.000Z"),
        card("active", "2026-07-20T00:00:00.000Z"),
        card("active", "2026-08-25T00:00:00.000Z"),
        card("paused", "2026-07-01T00:00:00.000Z")
      ],
      now
    );

    expect(summary).toEqual({ status: "scheduled", nextReviewAt: "2026-07-20T00:00:00.000Z" });
  });

  it("reports paused when the note's only cards are paused", () => {
    expect(
      summarizeNoteReview(
        [card("paused", "2026-07-01T00:00:00.000Z"), card("paused", "2026-09-01T00:00:00.000Z")],
        now
      )
    ).toEqual({ status: "paused" });
  });
});
