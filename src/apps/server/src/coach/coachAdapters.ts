import { createFakeCoach } from "./fakeCoach.js";
import { createLlmCoach, type ChatModel } from "./llmCoach.js";
import type { CoachAdapters } from "./coachConfig.js";

// Default local model for the cheap tier: llama3.1:8b is the English-best small model for an
// English-only coach. Swap to qwen3 only when the coach broadens to bilingual coaching (#241).
const defaultCheapModel = "llama3.1:8b";

/* v8 ignore start -- network boundaries, exercised via the injected ChatModel in tests */
function createOllamaChat(model: string): ChatModel {
  return async (prompt) => {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      body: JSON.stringify({ model, prompt, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const body = (await response.json()) as { response?: string };
    return body.response ?? "";
  };
}

function createCloudChat(apiKey: string): ChatModel {
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

// The cost tiers: cheap = local Ollama; strong = cloud (the one paid judge call/round). Both compose
// the LLM judge over the deterministic fake, so any model/parse failure still grades the round.
export function createCoachAdapters(apiKey: string, cheapModel = defaultCheapModel): CoachAdapters {
  const fallback = createFakeCoach();
  return {
    cheap: createLlmCoach({ chat: createOllamaChat(cheapModel), fallback }),
    strong: createLlmCoach({ chat: createCloudChat(apiKey), fallback })
  };
}
