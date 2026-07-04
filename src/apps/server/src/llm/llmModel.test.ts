import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaModel, ollamaBaseUrl, probeOllamaModel } from "./llmModel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOllamaModel", () => {
  it("sends the prompt through the SDK and returns the model's completion text", async () => {
    let seenPrompt: string | undefined;
    const model = createOllamaModel(
      "llama3.1:8b",
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          // The prompt is threaded to the model as a single user message — assert it arrives verbatim
          // so a dropped/garbled prompt fails here rather than silently degrading the completion.
          const part = options.prompt.at(-1)?.content?.at(0);
          seenPrompt = part && part.type === "text" ? part.text : undefined;
          return {
            content: [{ text: "the completion", type: "text" }],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            warnings: []
          };
        }
      })
    );

    await expect(model("explain this")).resolves.toBe("the completion");
    expect(seenPrompt).toBe("explain this");
  });

  // The mock's doGenerate carries the SDK-normalized `responseFormat`; the OpenAI-compatible provider
  // maps `{ type: "json" }` to the chat request's `response_format: { type: "json_object" }`.
  function formatProbe(): {
    model: ReturnType<typeof createOllamaModel>;
    seen: () => unknown;
  } {
    let seen: unknown;
    const model = createOllamaModel(
      "llama3.1:8b",
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          seen = options.responseFormat;
          return {
            content: [{ text: '{"say":"ok"}', type: "text" }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: []
          };
        }
      })
    );
    return { model, seen: () => seen };
  }

  it("requests the provider's JSON mode when json output is asked for (#433)", async () => {
    const probe = formatProbe();
    await probe.model("give me json", { json: true });
    expect(probe.seen()).toEqual({ type: "json" });
  });

  it("leaves the prose path unchanged (no JSON mode) when json is not requested", async () => {
    const probe = formatProbe();
    await probe.model("just prose");
    expect(probe.seen()).toBeUndefined();
  });
});

describe("probeOllamaModel", () => {
  function mockTags(payload: unknown, ok = true): ReturnType<typeof vi.spyOn> {
    return vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ json: () => Promise.resolve(payload), ok } as unknown as Response);
  }

  it("reports true when the model is listed as serving on the daemon", async () => {
    const spy = mockTags({ models: [{ name: "qwen2.5" }, { name: "llama3.1:8b" }] });

    await expect(probeOllamaModel("llama3.1:8b")).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(`${ollamaBaseUrl}/api/tags`, expect.anything());
  });

  it("reports false when the model is not among the served models", async () => {
    mockTags({ models: [{ name: "qwen2.5" }] });

    await expect(probeOllamaModel("llama3.1:8b")).resolves.toBe(false);
  });

  it("reports false when the daemon omits the models list entirely", async () => {
    mockTags({});

    await expect(probeOllamaModel("llama3.1:8b")).resolves.toBe(false);
  });

  it("reports false on a non-200 response instead of throwing", async () => {
    mockTags({}, false);

    await expect(probeOllamaModel("llama3.1:8b")).resolves.toBe(false);
  });

  it("reports false when the daemon is unreachable (fetch rejects) instead of crashing boot", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:11434"));

    await expect(probeOllamaModel("llama3.1:8b")).resolves.toBe(false);
  });
});
