import { describe, expect, it } from "vitest";

import {
  isRequiredRecitationStep,
  recitationSessionSteps,
  selectRecitationSessionStep
} from "./recitationSession.js";

describe("selectRecitationSessionStep", () => {
  it("lists the due-first session steps in priority order ending in clear", () => {
    expect(recitationSessionSteps).toEqual([
      "due_passage",
      "whole_work",
      "chain",
      "new_passage",
      "clear"
    ]);
  });

  it("prefers a due passage when every step is available", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: true,
        newPassageAvailable: true,
        wholeWorkDue: true
      })
    ).toBe("due_passage");
  });

  it("falls to whole-work before chain when no passage is due", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: true
      })
    ).toBe("whole_work");
  });

  it("falls to chain when no passage or whole-work target is due", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: false
      })
    ).toBe("chain");
  });

  it("falls to new-passage introduction after due work and chain are clear", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: false,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: false
      })
    ).toBe("new_passage");
  });

  it("is clear when no recitation session step remains", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: false,
        hasDuePassage: false,
        newPassageAvailable: false,
        wholeWorkDue: false
      })
    ).toBe("clear");
  });
});

describe("isRequiredRecitationStep", () => {
  it("treats due-passage, whole-work, and chain as required obligations", () => {
    expect(isRequiredRecitationStep("due_passage")).toBe(true);
    expect(isRequiredRecitationStep("whole_work")).toBe(true);
    expect(isRequiredRecitationStep("chain")).toBe(true);
  });

  it("treats the new-passage invitation and the terminal clear as not required", () => {
    expect(isRequiredRecitationStep("new_passage")).toBe(false);
    expect(isRequiredRecitationStep("clear")).toBe(false);
  });
});
