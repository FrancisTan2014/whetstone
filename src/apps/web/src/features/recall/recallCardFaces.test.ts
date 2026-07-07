import { describe, expect, it } from "vitest";

import type { RecallItemDto } from "@whetstone/contracts";

import { recallCardFaces } from "./recallCardFaces";

function makeItem(overrides: Partial<RecallItemDto> = {}): RecallItemDto {
  return {
    chunkId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "r1",
    kind: "word",
    provenanceEntryId: null,
    review: {
      dueAt: "2026-01-01T00:00:00.000Z",
      easeFactor: 2.5,
      intervalDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      repetitions: 0
    },
    text: "spill the beans",
    cue: null,
    useContext: null,
    category: null,
    tags: null,
    sourceProposalCandidateId: null,
    ...overrides
  };
}

describe("recallCardFaces", () => {
  it("production (cue present): front is the cue, back is text + gloss + useContext", () => {
    const faces = recallCardFaces(
      makeItem({
        cue: "Say you kept a secret in.",
        text: "spill the beans",
        gloss: "to reveal a secret",
        useContext: "casual conversation"
      })
    );

    expect(faces.front).toBe("Say you kept a secret in.");
    expect(faces.back).toEqual(["spill the beans", "to reveal a secret", "casual conversation"]);
    expect(faces.answerless).toBe(false);
  });

  it("recognition (cue absent): front is the text, back is gloss + useContext", () => {
    const faces = recallCardFaces(
      makeItem({
        cue: null,
        text: "spill the beans",
        gloss: "to reveal a secret",
        useContext: null
      })
    );

    expect(faces.front).toBe("spill the beans");
    expect(faces.back).toEqual(["to reveal a secret"]);
    expect(faces.answerless).toBe(false);
  });

  it("degenerate (no back content): front is the text and the card is answerless", () => {
    const faces = recallCardFaces(
      makeItem({ cue: null, text: "Mitigation (noun)", gloss: null, useContext: null })
    );

    expect(faces.front).toBe("Mitigation (noun)");
    expect(faces.back).toEqual([]);
    expect(faces.answerless).toBe(true);
  });

  it("treats a blank cue as absent (falls back to recognition)", () => {
    const faces = recallCardFaces(
      makeItem({ cue: "   ", text: "by and large", gloss: "on the whole", useContext: null })
    );

    expect(faces.front).toBe("by and large");
    expect(faces.back).toEqual(["on the whole"]);
  });
});
