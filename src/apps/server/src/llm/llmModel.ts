import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";

// The ONE model boundary for whetstone (#385): a prompt in, the model's completion text out. This is
// the single documented "model-agnostic LLM seam" every consumer depends on — the coach's cheap tier,
// the diary "tidy" pass, and the lookup "AI 解释" tab. Consumers and their tests depend only on THIS
// type, never on the underlying SDK, so the SDK stays a swappable implementation detail.
export type LlmModel = (prompt: string) => Promise<string>;

// Where the local Ollama daemon serves (its fixed default port). The health probe hits the daemon's
// native `/api/tags`; the SDK adapter talks to Ollama's OpenAI-compatible `/v1` endpoint below — so a
// later cloud swap is a base-URL/provider change behind the same seam, not a rewrite.
export const ollamaBaseUrl = "http://127.0.0.1:11434";

// One shared wall-clock bound for every LLM call. Local generation is slow, but a stalled/unresponsive
// daemon must never hang a coach/diary/explain request unbounded (closing the old no-timeout gap on the
// coach path). 60s is generous enough for real local generation while still bounding a hung daemon; on
// timeout the SDK aborts and the call rejects, so each consumer degrades to its own fallback.
export const llmTimeoutMs = 60_000;

/* v8 ignore start -- provider construction reaches the network; the adapter is tested via an injected mock model */
function ollamaLanguageModel(model: string): LanguageModel {
  return createOpenAICompatible({ baseURL: `${ollamaBaseUrl}/v1`, name: "ollama" })(model);
}
/* v8 ignore stop */

// The local adapter: run the prompt through the Vercel AI SDK over the Ollama OpenAI-compatible
// endpoint and return the completion text, time-boxed by the shared bound. `languageModel` is the SDK's
// own model abstraction — injected in tests as a mock model so the adapter is exercised with no network,
// defaulting to the real Ollama provider in production.
export function createOllamaModel(
  model: string,
  languageModel: LanguageModel = ollamaLanguageModel(model)
): LlmModel {
  return async (prompt) => {
    const { text } = await generateText({
      abortSignal: AbortSignal.timeout(llmTimeoutMs),
      model: languageModel,
      prompt
    });
    return text;
  };
}

// Boot health probe (#271): is `model` pulled and serving on the local Ollama daemon? Asks the daemon's
// native `/api/tags` and checks membership. Any failure (daemon down, non-200, parse error) surfaces as
// "not available" so the health check stays a report, never a crash — the consumer falls back regardless.
export async function probeOllamaModel(model: string): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(llmTimeoutMs)
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { models?: ReadonlyArray<{ name?: string }> };
    return (body.models ?? []).some((entry) => entry.name === model);
  } catch {
    return false;
  }
}
