import { describe, expect, it } from "vitest";

import { deriveRecitationStage, recitationRoutineStages } from "./recitationHub.js";

describe("deriveRecitationStage", () => {
  it("maps the familiarizing phase to familiarize regardless of chaining", () => {
    expect(
      deriveRecitationStage({ chainEligible: true, hasActiveChain: true, phase: "familiarizing" })
    ).toBe("familiarize");
  });

  it("maps the maintenance phase to whole-work maintenance regardless of chaining", () => {
    expect(
      deriveRecitationStage({ chainEligible: false, hasActiveChain: false, phase: "maintenance" })
    ).toBe("whole_work_maintenance");
  });

  it("maps learning with an active chain to chain", () => {
    expect(
      deriveRecitationStage({ chainEligible: false, hasActiveChain: true, phase: "learning" })
    ).toBe("chain");
  });

  it("maps learning that is chain-eligible but with no open chain to chain", () => {
    expect(
      deriveRecitationStage({ chainEligible: true, hasActiveChain: false, phase: "learning" })
    ).toBe("chain");
  });

  it("maps learning with neither an active nor an eligible chain to learn_passage", () => {
    expect(
      deriveRecitationStage({ chainEligible: false, hasActiveChain: false, phase: "learning" })
    ).toBe("learn_passage");
  });

  it("lists the four stages in routine order", () => {
    expect(recitationRoutineStages).toEqual([
      "familiarize",
      "learn_passage",
      "chain",
      "whole_work_maintenance"
    ]);
  });
});
