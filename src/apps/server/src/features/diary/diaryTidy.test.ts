import { describe, expect, it, vi } from "vitest";

import { buildDiaryTidyPrompt } from "@whetstone/domain";

import { createDiaryTidy, resolveDiaryTidy } from "./diaryTidy.js";

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

  it("falls back to the raw transcript when the model drops a negation (#462 review)", async () => {
    // Deleting "not" reverses the meaning; the faithfulness guard rejects it even though every remaining
    // word is present in the raw, so the learner's original words are saved.
    const tidy = createDiaryTidy(async () => "I did finish the task");

    await expect(tidy("I did not finish the task")).resolves.toBe("I did not finish the task");
  });
});

describe("resolveDiaryTidy", () => {
  it("returns an identity tidier (the faithful transcript) when no model is configured, calling no factory", async () => {
    const createModel = vi.fn();
    const tidy = resolveDiaryTidy({ config: { modelName: undefined }, createModel });

    await expect(tidy("the original words")).resolves.toBe("the original words");
    expect(createModel).not.toHaveBeenCalled();
  });

  it("returns an identity tidier when a model is configured but no factory is wired", async () => {
    const tidy = resolveDiaryTidy({ config: { modelName: "llama3.1:8b" } });

    await expect(tidy("the original words")).resolves.toBe("the original words");
  });

  it("builds a real tidier from the configured model when a factory is wired", async () => {
    const chat = vi.fn(async () => "Today I read a book");
    const createModel = vi.fn(() => chat);
    const tidy = resolveDiaryTidy({ config: { modelName: "llama3.1:8b" }, createModel });

    await expect(tidy("um today I, I read a book")).resolves.toBe("Today I read a book");
    expect(createModel).toHaveBeenCalledWith("llama3.1:8b");
    expect(chat).toHaveBeenCalledWith(buildDiaryTidyPrompt("um today I, I read a book"));
  });
});
