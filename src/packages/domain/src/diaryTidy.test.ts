import { describe, expect, it } from "vitest";

import { buildDiaryTidyPrompt, diaryTidyInstructions, isFaithfulTidy } from "./diaryTidy.js";

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

describe("isFaithfulTidy", () => {
  it("accepts a tidy that only drops fillers/repeats and lightly reorders", () => {
    expect(isFaithfulTidy("um today I, I read a book", "Today I read a book")).toBe(true);
    // Light reorder keeps the same words.
    expect(isFaithfulTidy("today, quietly, I read", "Quietly I read today")).toBe(true);
  });

  it("accepts an unchanged transcript and is case-insensitive", () => {
    expect(isFaithfulTidy("I felt calm", "I felt calm")).toBe(true);
    expect(isFaithfulTidy("I Felt Calm", "i felt calm")).toBe(true);
  });

  it("rejects the #462 rewrite that upgrades and substitutes words", () => {
    const raw =
      "I felt calm after reading one page today. I want to keep the habit small and sustainable.";
    const rewrite =
      "I felt calm after one page today. I want this habit to be small and manageable.";
    // Introduces "this", "be", "manageable" — none in the raw input.
    expect(isFaithfulTidy(raw, rewrite)).toBe(false);
  });

  it("rejects a single upgraded word", () => {
    expect(isFaithfulTidy("the deploy is happy", "the deploy is delighted")).toBe(false);
  });

  it("rejects repeating a word more than the raw did (not a pure drop/reorder)", () => {
    expect(isFaithfulTidy("I read a book", "I read a a book")).toBe(false);
  });

  it("handles CJK per character: a dropped filler is faithful, a substitution is not", () => {
    // Dropping the filler 嗯 keeps a subset of the raw characters.
    expect(isFaithfulTidy("嗯 今天 我 读 了 一 页", "今天 我 读 了 一 页")).toBe(true);
    // Substituting 页 → 章 introduces a character absent from the raw.
    expect(isFaithfulTidy("今天 我 读 了 一 页", "今天 我 读 了 一 章")).toBe(false);
  });
});
