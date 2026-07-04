import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware
} from "ai";

// The ONE model boundary for whetstone (#385): a prompt in, the model's completion text out. This is
// the single documented "model-agnostic LLM seam" every consumer depends on — the coach's cheap tier,
// the diary "tidy" pass, and the lookup "AI 解释" tab. Consumers and their tests depend only on THIS
// type, never on the underlying SDK, so the SDK stays a swappable implementation detail.
//
// `options.json` (#433) is opt-in structured output: JSON-expecting callers (the coach's converse/
// analyze) request the provider's JSON mode so the completion is reliably valid JSON, while prose
// callers (diary tidy, lookup explain) omit it and are unchanged. The seam stays "text out" — the
// caller still parses the JSON — so it is not a typed-object seam.
export type LlmModel = (prompt: string, options?: LlmCallOptions) => Promise<string>;

export type LlmCallOptions = Readonly<{ json?: boolean }>;

// A chat-capable model instance (the SDK's own model object), excluding the bare model-id string form
// of `LanguageModel` — `wrapLanguageModel` needs a concrete model, not an id.
type ChatModel = Exclude<LanguageModel, string>;

// Where the local Ollama daemon serves (its fixed default port). The health probe hits the daemon's
// native `/api/tags`; the SDK adapter talks to Ollama's OpenAI-compatible `/v1` endpoint below — so a
// later cloud swap is a base-URL/provider change behind the same seam, not a rewrite.
export const ollamaBaseUrl = "http://127.0.0.1:11434";

// One shared wall-clock bound for every LLM call. Local generation is slow, but a stalled/unresponsive
// daemon must never hang a coach/diary/explain request unbounded (closing the old no-timeout gap on the
// coach path). 60s is generous enough for real local generation while still bounding a hung daemon; on
// timeout the SDK aborts and the call rejects, so each consumer degrades to its own fallback.
export const llmTimeoutMs = 60_000;

// Force the provider's JSON object mode for one call. `generateText` always sets a default
// `responseFormat: { type: "text" }` on the model params, and `defaultSettingsMiddleware` can't override
// it (its defaults lose to the explicit param), so we OVERRIDE via a `transformParams` middleware — the
// SDK's designed extension point. The OpenAI-compatible provider maps `responseFormat: { type: "json" }`
// (no schema) to the chat request's `response_format: { type: "json_object" }`, which makes the small
// local llama3.1:8b emit valid JSON instead of the prompt-only shape it intermittently mangled (#433).
const jsonResponseFormatMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, responseFormat: { type: "json" } })
};

/* v8 ignore start -- provider construction reaches the network; the adapter is tested via an injected mock model */
function ollamaLanguageModel(model: string): ChatModel {
  return createOpenAICompatible({ baseURL: `${ollamaBaseUrl}/v1`, name: "ollama" })(model);
}
/* v8 ignore stop */

// The local adapter: run the prompt through the Vercel AI SDK over the Ollama OpenAI-compatible
// endpoint and return the completion text, time-boxed by the shared bound. `languageModel` is the SDK's
// own model abstraction — injected in tests as a mock model so the adapter is exercised with no network,
// defaulting to the real Ollama provider in production. When `options.json` is set, the model is wrapped
// to request JSON mode for this call only.
export function createOllamaModel(
  model: string,
  languageModel: ChatModel = ollamaLanguageModel(model)
): LlmModel {
  return async (prompt, options) => {
    const resolved =
      options?.json === true
        ? wrapLanguageModel({ model: languageModel, middleware: jsonResponseFormatMiddleware })
        : languageModel;
    const { text } = await generateText({
      abortSignal: AbortSignal.timeout(llmTimeoutMs),
      model: resolved,
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
