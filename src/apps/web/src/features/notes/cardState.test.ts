import type { NotePromptCardStateDto, NotePromptRevealPolicyDto } from "@whetstone/contracts";
import { formatNextReviewLabel } from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import { cardStateLabel, revealSummaryLabel } from "./cardState";

const now = new Date("2026-07-01T00:00:00.000Z");
const timeZone = "UTC";

describe("cardStateLabel", () => {
  it("labels a due card", () => {
    expect(cardStateLabel({ state: "due" }, now, timeZone)).toBe("Due now");
  });

  it("labels a paused card", () => {
    expect(cardStateLabel({ state: "paused" }, now, timeZone)).toBe("Paused");
  });

  it("labels a card that is not in review", () => {
    expect(cardStateLabel({ state: "not_in_review" }, now, timeZone)).toBe("Not in review");
  });

  it("projects the shared next-review phrase for a scheduled card", () => {
    const nextReviewAt = "2026-07-11T00:00:00.000Z";
    const state: NotePromptCardStateDto = { nextReviewAt, state: "scheduled" };
    expect(cardStateLabel(state, now, timeZone)).toBe(
      `Next review · ${formatNextReviewLabel({ due: new Date(nextReviewAt), now, timeZone })}`
    );
  });
});

describe("revealSummaryLabel", () => {
  it("summarizes a current-note reveal", () => {
    expect(revealSummaryLabel({ kind: "current_note" })).toBe("Whole note");
  });

  it("summarizes a success-check reveal", () => {
    const reveal: NotePromptRevealPolicyDto = {
      kind: "expected_response",
      successCheckDoc: { content: [], type: "doc" },
      successCheckText: "names durability"
    };
    expect(revealSummaryLabel(reveal)).toBe("Specific success check");
  });

  it("summarizes a preserved legacy reveal", () => {
    const reveal: NotePromptRevealPolicyDto = {
      answerDoc: { content: [], type: "doc" },
      answerText: "a write-ahead log",
      kind: "legacy_custom"
    };
    expect(revealSummaryLabel(reveal)).toBe("Legacy answer");
  });
});
