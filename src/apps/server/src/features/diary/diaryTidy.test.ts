import { describe, expect, it, vi } from "vitest";

import { buildDiaryTidyPrompt } from "@whetstone/domain";

import { AgentError } from "../../agent/agentFailure.js";

import { createDiaryTidy, resolveDiaryTidy, selectDiaryTidyBackend } from "./diaryTidy.js";

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

  it("prefers the agent-backed model over the local Ollama model when a local agent is configured (#906)", async () => {
    // The point of the agent backend: tidy works on a machine that cannot host a resident local LLM,
    // so a configured agent must win even when DIARY_TIDY_MODEL is still set from an earlier install.
    const agentModel = vi.fn(async () => "Today I read a book");
    const createModel = vi.fn(() => async () => "from ollama");
    const tidy = resolveDiaryTidy({
      agentModel,
      config: { modelName: "llama3.1:8b" },
      createModel
    });

    await expect(tidy("um today I, I read a book")).resolves.toBe("Today I read a book");
    expect(agentModel).toHaveBeenCalledWith(buildDiaryTidyPrompt("um today I, I read a book"));
    expect(createModel).not.toHaveBeenCalled();
  });

  it("uses the agent-backed model with no Ollama model configured at all", async () => {
    const agentModel = vi.fn(async () => "Today I read a book");
    const tidy = resolveDiaryTidy({ agentModel, config: { modelName: undefined } });

    await expect(tidy("um today I, I read a book")).resolves.toBe("Today I read a book");
  });

  it("keeps every tidy guarantee when the agent backs it: a failed turn saves the raw transcript", async () => {
    // A local agent CLI fails in ways Ollama does not (missing binary, expired credential, non-zero
    // exit). None of them may cost the learner their entry.
    const tidy = resolveDiaryTidy({
      agentModel: async () => {
        throw new AgentError("agent_exit_failed", "the CLI exited with code 1");
      },
      config: { modelName: undefined }
    });

    await expect(tidy("the original words")).resolves.toBe("the original words");
  });

  it("keeps the faithfulness guard when the agent backs it: a rewrite saves the raw transcript", async () => {
    const raw =
      "I felt calm after reading one page today. I want to keep the habit small and sustainable.";
    const tidy = resolveDiaryTidy({
      agentModel: async () =>
        "I felt calm after one page today. I want this habit to be small and manageable.",
      config: { modelName: undefined }
    });

    await expect(tidy(raw)).resolves.toBe(raw);
  });
});

describe("selectDiaryTidyBackend", () => {
  it("reports the agent backend exactly when an agent-backed model is wired", () => {
    expect(
      selectDiaryTidyBackend({ agentModel: async () => "x", config: { modelName: "m" } })
    ).toBe("agent");
    expect(selectDiaryTidyBackend({ config: { modelName: "m" } })).toBe("model");
    expect(selectDiaryTidyBackend({ config: { modelName: undefined } })).toBe("model");
  });

  it("agrees with the backend resolveDiaryTidy actually calls, so the boot log cannot mislead", async () => {
    const agentModel = vi.fn(async () => "Today I read a book");
    const ollama = vi.fn(async () => "Today I read a book");
    const dependencies = {
      agentModel,
      config: { modelName: "llama3.1:8b" },
      createModel: () => ollama
    };

    await resolveDiaryTidy(dependencies)("um today I, I read a book");

    expect(selectDiaryTidyBackend(dependencies)).toBe("agent");
    expect(agentModel).toHaveBeenCalledTimes(1);
    expect(ollama).not.toHaveBeenCalled();
  });
});
