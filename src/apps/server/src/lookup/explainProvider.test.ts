import { describe, expect, it, vi } from "vitest";

import {
  buildExplainPrompt,
  createLlmExplainer,
  formatExplanation,
  readExplainConfig,
  resolveExplainer,
  type ExplainModel
} from "./explainProvider.js";

const request = {
  context: "六艺者，礼、乐、射、御、书、数也。",
  language: "zh-CN",
  term: "六艺"
} as const;

describe("buildExplainPrompt", () => {
  it("includes the term, the context, and the language", () => {
    const prompt = buildExplainPrompt(request);

    expect(prompt).toContain("六艺");
    expect(prompt).toContain("六艺者，礼、乐、射、御、书、数也。");
    expect(prompt).toContain("zh-CN");
  });

  it("marks a missing or blank context explicitly rather than sending an empty line", () => {
    expect(buildExplainPrompt({ ...request, context: undefined })).toContain("（无上下文）");
    expect(buildExplainPrompt({ ...request, context: "   " })).toContain("（无上下文）");
  });
});

describe("formatExplanation", () => {
  it("builds a one-sense entry attributed to the local model", () => {
    const entry = formatExplanation("  指礼、乐、射、御、书、数六种技艺。 ", "qwen2.5", "六艺");

    expect(entry).toEqual({
      headword: "六艺",
      partsOfSpeech: [
        {
          senses: [{ definition: "指礼、乐、射、御、书、数六种技艺。", examples: [], synonyms: [] }]
        }
      ],
      pronunciations: [],
      sources: ["AI 解释 · qwen2.5 (local)"]
    });
  });

  it("returns null for an empty or whitespace-only response (never a fabricated entry)", () => {
    expect(formatExplanation("", "qwen2.5", "六艺")).toBeNull();
    expect(formatExplanation("   \n ", "qwen2.5", "六艺")).toBeNull();
  });
});

describe("createLlmExplainer", () => {
  it("prompts the model and formats its answer into an entry", async () => {
    const model: ExplainModel = vi.fn().mockResolvedValue("在此句中指六种技艺。");
    const explain = createLlmExplainer({ model, modelName: "qwen2.5" });

    const entry = await explain(request);

    expect(model).toHaveBeenCalledWith(buildExplainPrompt(request));
    expect(entry?.partsOfSpeech[0]?.senses[0]?.definition).toBe("在此句中指六种技艺。");
    expect(entry?.sources).toEqual(["AI 解释 · qwen2.5 (local)"]);
  });

  it("returns null when the model returns an empty answer", async () => {
    const explain = createLlmExplainer({ model: async () => "", modelName: "qwen2.5" });

    expect(await explain(request)).toBeNull();
  });

  it("returns null when the model call throws (timeout/daemon down), never hanging or crashing", async () => {
    const explain = createLlmExplainer({
      model: async () => {
        throw new Error("aborted");
      },
      modelName: "qwen2.5"
    });

    expect(await explain(request)).toBeNull();
  });
});

describe("readExplainConfig", () => {
  it("reads the model name from EXPLAIN_MODEL, trimming it", () => {
    expect(readExplainConfig({ EXPLAIN_MODEL: "  qwen2.5  " }).modelName).toBe("qwen2.5");
  });

  it("is undefined (disabled) when EXPLAIN_MODEL is unset or blank", () => {
    expect(readExplainConfig({}).modelName).toBeUndefined();
    expect(readExplainConfig({ EXPLAIN_MODEL: "   " }).modelName).toBeUndefined();
  });
});

describe("resolveExplainer", () => {
  it("returns an unavailable provider (null) when no model is configured", async () => {
    const createModel = vi.fn();
    const explain = resolveExplainer({ config: { modelName: undefined }, createModel });

    expect(await explain(request)).toBeNull();
    expect(createModel).not.toHaveBeenCalled();
  });

  it("returns an unavailable provider (null) when no model factory is wired", async () => {
    const explain = resolveExplainer({ config: { modelName: "qwen2.5" } });

    expect(await explain(request)).toBeNull();
  });

  it("builds the real explainer from the configured model when both are present", async () => {
    const model: ExplainModel = async () => "语境中的解释。";
    const createModel = vi.fn().mockReturnValue(model);
    const explain = resolveExplainer({ config: { modelName: "qwen2.5" }, createModel });

    const entry = await explain(request);

    expect(createModel).toHaveBeenCalledWith("qwen2.5");
    expect(entry?.partsOfSpeech[0]?.senses[0]?.definition).toBe("语境中的解释。");
  });
});
