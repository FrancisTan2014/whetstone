import { describe, expect, it, vi } from "vitest";

import { buildDiaryTidyPrompt } from "@whetstone/domain";

import { createDiaryTidy } from "./diaryTidy.js";

describe("createDiaryTidy", () => {
  it("builds the tidy prompt, calls the model, and trims the reply", async () => {
    const chat = vi.fn(async () => "  Today I read a book.  ");
    const tidy = createDiaryTidy(chat);

    const result = await tidy("um today I, I read a book");

    expect(result).toBe("Today I read a book.");
    expect(chat).toHaveBeenCalledWith(buildDiaryTidyPrompt("um today I, I read a book"));
  });

  it("falls back to the raw transcript when the model returns blank, so an entry is never emptied", async () => {
    const tidy = createDiaryTidy(async () => "   ");

    await expect(tidy("the original words")).resolves.toBe("the original words");
  });

  it("falls back to the raw transcript when the model call fails, so tidy never breaks capture", async () => {
    // Ollama down / not pulled / fetch or parse error: tidy degrades to the faithful raw transcript
    // rather than throwing and failing the save (#246).
    const tidy = createDiaryTidy(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:11434");
    });

    await expect(tidy("the original words")).resolves.toBe("the original words");
  });

  it("falls back to the raw transcript when the model rewrites the wording (#462)", async () => {
    const raw =
      "I felt calm after reading one page today. I want to keep the habit small and sustainable.";
    // The model ignores the prompt and upgrades/substitutes words ("this", "be", "manageable"). The
    // deterministic faithfulness guard rejects it, keeping the diary a trustworthy learner-history signal.
    const tidy = createDiaryTidy(
      async () => "I felt calm after one page today. I want this habit to be small and manageable."
    );

    await expect(tidy(raw)).resolves.toBe(raw);
  });

  it("keeps a faithful tidy that only drops fillers and reorders", async () => {
    const tidy = createDiaryTidy(async () => "Today I read a book");

    await expect(tidy("um today I, I read a book")).resolves.toBe("Today I read a book");
  });
});
