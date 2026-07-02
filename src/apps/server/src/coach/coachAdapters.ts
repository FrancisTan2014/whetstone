import { createFakeCoach } from "./fakeCoach.js";
import { createLlmCoach } from "./llmCoach.js";
import type { CoachAdapters } from "./coachConfig.js";
import { createOllamaModel, type LlmModel } from "../llm/llmModel.js";

// Default local model for the cheap tier: llama3.1:8b is the English-best small model for an
// English-only coach. Swap to qwen3 only when the coach broadens to bilingual coaching (#241).
export const defaultCheapModel = "llama3.1:8b";

/* v8 ignore start -- cloud network boundary, exercised via an injected LlmModel in tests */
function createCloudChat(apiKey: string): LlmModel {
  return async (prompt) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ input: prompt, model: "gpt-5-mini" }),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      method: "POST"
    });
    const body = (await response.json()) as { output_text?: string };
    return body.output_text ?? "";
  };
}
/* v8 ignore stop */

// The model factories the tiers are built from: `createLocal` builds the local Ollama-backed `LlmModel`
// (cheap tier); `createCloud` builds the cloud-backed `LlmModel` (strong tier). Injectable so tests fake
// the seam — never the network — while production defaults to the real adapters.
export type CoachModelFactories = Readonly<{
  createCloud: (apiKey: string) => LlmModel;
  createLocal: (model: string) => LlmModel;
}>;

const defaultModelFactories: CoachModelFactories = {
  createCloud: createCloudChat,
  createLocal: createOllamaModel
};

// The cost tiers: cheap = local Ollama (never needs a key); strong = cloud (the one paid judge call/
// round) only when a key is present, otherwise the deterministic fake. So a keyless dev still gets a
// real LOCAL cheap tier, while any strong-routed call safely resolves to the fake — no key required.
// The cheap tier composes the LLM judge over the fake, so any model/parse failure still grades the round.
export function createCoachAdapters(
  apiKey: string | undefined,
  cheapModel = defaultCheapModel,
  factories: CoachModelFactories = defaultModelFactories
): CoachAdapters {
  const fallback = createFakeCoach();
  return {
    cheap: createLlmCoach({ chat: factories.createLocal(cheapModel), fallback }),
    strong:
      apiKey === undefined || apiKey.length === 0
        ? createFakeCoach()
        : createLlmCoach({ chat: factories.createCloud(apiKey), fallback })
  };
}
