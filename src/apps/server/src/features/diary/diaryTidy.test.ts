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
});
