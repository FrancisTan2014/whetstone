import { describe, expect, it } from "vitest";

import type { CaptureSource } from "./memoryLabels";
import { captureSourceLabel, memoryState, promptCountLabel } from "./memoryLabels";

describe("captureSourceLabel", () => {
  const cases: ReadonlyArray<Readonly<[CaptureSource, string]>> = [
    ["manual", "Added by you"],
    ["reader", "From reading"],
    ["import", "Imported"],
    ["practice", "From practice"],
    ["tool", "From a tool"]
  ];

  for (const [source, label] of cases) {
    it(`labels ${source} as "${label}"`, () => {
      expect(captureSourceLabel(source)).toBe(label);
    });
  }
});

describe("promptCountLabel", () => {
  it("reads none as 'No prompts'", () => {
    expect(promptCountLabel(0)).toBe("No prompts");
  });

  it("reads one in the singular", () => {
    expect(promptCountLabel(1)).toBe("1 prompt");
  });

  it("reads many in the plural", () => {
    expect(promptCountLabel(3)).toBe("3 prompts");
  });
});

describe("memoryState", () => {
  it("shows the due count when anything is due (due wins over scheduled)", () => {
    expect(memoryState({ dueCount: 2, scheduledCount: 5 })).toEqual({ label: "2 due", tone: "due" });
  });

  it("shows Scheduled when nothing is due but a prompt is scheduled", () => {
    expect(memoryState({ dueCount: 0, scheduledCount: 1 })).toEqual({
      label: "Scheduled",
      tone: "scheduled"
    });
  });

  it("shows Draft when nothing is due or scheduled", () => {
    expect(memoryState({ dueCount: 0, scheduledCount: 0 })).toEqual({
      label: "Draft",
      tone: "draft"
    });
  });
});
