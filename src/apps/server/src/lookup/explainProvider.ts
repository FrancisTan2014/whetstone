import type { DictionaryEntry } from "@whetstone/contracts";

// The lookup "Explain in context" seam (#341): an optional, local-first LLM aid for Chinese selections
// that dictionaries structurally miss (classical-Chinese terms, 成語, allusions, proper nouns). It is a
// clearly-labeled contextual explanation, NEVER dressed as an authoritative dictionary entry — its
// superpower is explaining the selected span AS USED IN ITS SENTENCE, exactly where dictionaries dead
// end. Absent-config-safe, mirroring the coach seam (#206): with no model configured it resolves to a
// provider that returns null, so the tab shows the honest "unavailable" state and `pnpm validate` stays
// green with no model. The network boundary (the real Ollama call) lives in the wiring layer
// (index.ts), injected here as `ExplainModel`, so this module stays pure and fully testable.

// One explanation request: the selected term, its containing block text (bounded context), and the
// work language, so the prompt can ask for a brief 文言-aware gloss of the term in context.
export type ExplainRequest = Readonly<{
  context: string | undefined;
  language: string;
  term: string;
}>;

// The model-agnostic call: a prompt in, the model's raw text out. The concrete local (Ollama) or cloud
// implementation is injected by the wiring layer; tests inject a deterministic fake.
export type ExplainModel = (prompt: string) => Promise<string>;

// An explanation source: the selected span explained in context, or null when there is nothing to show
// (no model configured, a timeout/error, or an empty response) so the tab falls to its honest empty
// state. Matches the `LookupSource.lookup` shape's return so it plugs straight into the lookup service.
export type ExplainProvider = (request: ExplainRequest) => Promise<DictionaryEntry | null>;

// Build the model prompt from the request. It constrains the model to a short, plain contextual gloss
// (not a dictionary dump) and hands it the term plus its surrounding sentence/block so it can explain
// the sense in use. Kept pure so its shape is asserted directly.
export function buildExplainPrompt(request: ExplainRequest): string {
  const contextLine =
    request.context === undefined || request.context.trim().length === 0
      ? "（无上下文）"
      : request.context.trim();

  return [
    "你是一位精通文言文的中文老师。请用简体中文，简明解释所选词语在其上下文句子中的含义，",
    "重点说明它在这句话里的用法（可涉及典故、古义、专名）。只输出一段简短解释，不要罗列词典义项。",
    `所选词语：${request.term}`,
    `上下文：${contextLine}`,
    `文本语言：${request.language}`
  ].join("\n");
}

// Format the model's text into a DictionaryEntry the panel renders: one part-of-speech-less group with
// one sense carrying the gloss (so `stateHasContent` is true), attributed as a local AI aid. An empty
// or whitespace-only response is null (nothing to show), so a silent/blank model never fabricates an
// entry. The AI-generated caveat is surfaced by the web badge; the attribution names the local model.
export function formatExplanation(
  text: string,
  modelName: string,
  term: string
): DictionaryEntry | null {
  const gloss = text.trim();

  if (gloss.length === 0) {
    return null;
  }

  return {
    headword: term,
    partsOfSpeech: [{ senses: [{ definition: gloss, examples: [], synonyms: [] }] }],
    pronunciations: [],
    sources: [`AI 解释 · ${modelName} (local)`]
  };
}

// Build an explanation provider over an injected model. Any thrown error (the injected Ollama call
// aborts on timeout, the daemon is down, etc.) resolves to null so the tab shows its honest error state
// rather than hanging or crashing — the fail-safe stance every lookup source takes.
export function createLlmExplainer(dependencies: {
  model: ExplainModel;
  modelName: string;
}): ExplainProvider {
  return async (request) => {
    try {
      const text = await dependencies.model(buildExplainPrompt(request));
      return formatExplanation(text, dependencies.modelName, request.term);
    } catch {
      return null;
    }
  };
}

// The explainer config: the local model name to use, or undefined when unset (the aid is disabled).
// Absent-config-safe like the coach config — no env means the deterministic "unavailable" default.
export type ExplainConfig = Readonly<{ modelName: string | undefined }>;

export function readExplainConfig(env: NodeJS.ProcessEnv = process.env): ExplainConfig {
  const raw = env.EXPLAIN_MODEL;
  const modelName = raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();

  return { modelName };
}

// Resolve the explanation provider: the real local-model explainer when BOTH a model is configured and
// a model factory is wired, otherwise a provider that always returns null (unavailable). No model, or
// no wired factory, both fall back to unavailable — the lookup never depends on a real model being
// configured, exactly like the coach seam.
export function resolveExplainer(dependencies: {
  config: ExplainConfig;
  createModel?: (modelName: string) => ExplainModel;
}): ExplainProvider {
  const { config, createModel } = dependencies;

  if (config.modelName === undefined || createModel === undefined) {
    return async () => null;
  }

  return createLlmExplainer({ model: createModel(config.modelName), modelName: config.modelName });
}
