import { describe, expect, it } from "vitest";

import { buildDiaryTidyPrompt, diaryTidyInstructions } from "./diaryTidy.js";

describe("buildDiaryTidyPrompt", () => {
  it("carries the tidy-not-polish invariant instructions", () => {
    const prompt = buildDiaryTidyPrompt("um so today I, I went to the park");

    for (const instruction of diaryTidyInstructions) {
      expect(prompt).toContain(instruction);
    }
  });

  it("instructs to preserve wording and never upgrade or translate", () => {
    const joined = diaryTidyInstructions.join("\n").toLowerCase();

    expect(joined).toContain("do not polish");
    expect(joined).toContain("preserve");
    expect(joined).toContain("never upgrade");
    expect(joined).toContain("translate");
    expect(joined).toContain("filler");
  });

  it("appends the transcript to tidy after the instructions", () => {
    const prompt = buildDiaryTidyPrompt("hello world");

    expect(prompt).toContain("Transcript:\nhello world");
    expect(prompt.indexOf("Transcript:")).toBeGreaterThan(
      prompt.indexOf(diaryTidyInstructions[0]!)
    );
  });
});
