import { describe, expect, it } from "vitest";

import { readDiaryTidyConfig } from "./aiUtilityConfig.js";

describe("readDiaryTidyConfig", () => {
  it("uses DIARY_TIDY_MODEL when set, trimming surrounding whitespace", () => {
    expect(readDiaryTidyConfig({ DIARY_TIDY_MODEL: "  llama3.1:8b  " })).toEqual({
      modelName: "llama3.1:8b"
    });
  });

  it("is disabled (undefined) when neither variable is set", () => {
    expect(readDiaryTidyConfig({})).toEqual({ modelName: undefined });
  });

  it("treats a blank DIARY_TIDY_MODEL as unset", () => {
    expect(readDiaryTidyConfig({ DIARY_TIDY_MODEL: "   " })).toEqual({ modelName: undefined });
  });

  it("honors COACH_MODEL as a one-release read-only alias when DIARY_TIDY_MODEL is absent", () => {
    expect(readDiaryTidyConfig({ COACH_MODEL: "qwen3" })).toEqual({ modelName: "qwen3" });
  });

  it("falls back to the COACH_MODEL alias when DIARY_TIDY_MODEL is blank", () => {
    expect(readDiaryTidyConfig({ DIARY_TIDY_MODEL: "  ", COACH_MODEL: "qwen3" })).toEqual({
      modelName: "qwen3"
    });
  });

  it("prefers DIARY_TIDY_MODEL over the COACH_MODEL alias when both are set", () => {
    expect(readDiaryTidyConfig({ DIARY_TIDY_MODEL: "llama3.1:8b", COACH_MODEL: "qwen3" })).toEqual({
      modelName: "llama3.1:8b"
    });
  });

  it("treats a blank COACH_MODEL alias as unset", () => {
    expect(readDiaryTidyConfig({ COACH_MODEL: "   " })).toEqual({ modelName: undefined });
  });
});
